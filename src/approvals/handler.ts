// A click on a shadow line's Confirm button (offer.ts). Only the owner (src/botOwner.ts, re-checked on every
// click; fails closed) may approve. The click is acknowledged at once (deferUpdate: posting can take longer
// than Discord's 3 seconds), the row is claimed so a double click acts once, and the action runs: post the
// birthday message, add the reaction. The report line then says what happened and loses its button; a
// failure a later click may fix keeps the button and is told privately.
import { type ButtonInteraction, type Client, MessageFlags } from 'discord.js';
import { ownerWithin } from '../commands/notesViewer';
import { logger } from '../logger';
import { type ApprovalPayload, claimApproval, completeApproval, releaseApproval } from './approvalStore';
import { parseApprovalCustomId } from './offer';

/**
 * What an approved action came to. `done`: it happened. `closed`: it never can (already announced, the
 * post is gone): the button goes away. `retry`: a later click may work (Discord hiccup): the button stays.
 * `note` is a short line for the report post (done/closed) or the clicker (retry).
 */
export type ApprovalResult = { status: 'done' | 'closed' | 'retry'; note: string };

export type ApprovalExecutor = (payload: ApprovalPayload, client: Client) => Promise<ApprovalResult>;

export type ApprovalDeps = {
  isOwner: (client: Client, userId: string) => Promise<boolean>;
  execute: ApprovalExecutor;
  now?: () => number;
};

export const APPROVAL_LINES = {
  notOwner: 'only the boss gets to sign off on these',
  ownerUnknown: "couldn't tell if you're the boss just now, click again in a sec",
  busy: 'already on it, hang on',
  alreadyDone: 'already took care of that one',
  unknown: 'no clue what that button was for anymore',
  expired: '⌛ too late for that one, the moment passed',
  failed: 'ugh, that broke on my end. click again in a bit',
} as const;

const MESSAGE_LIMIT = 2000;

/** The report line plus one `-#` outcome line, cut to fit one message. */
function withOutcome(content: string, line: string): string {
  const outcome = `\n-# ${line}`;
  const room = MESSAGE_LIMIT - outcome.length;
  const body = content.length > room ? `${content.slice(0, Math.max(0, room - 1))}…` : content;
  return `${body}${outcome}`;
}

/** A private line to the clicker, in whatever state the interaction is in. Never throws. */
async function tellPrivately(interaction: ButtonInteraction, content: string): Promise<void> {
  const options = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } } as const;
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(options);
    else await interaction.reply(options);
  } catch (error) {
    logger.warn(`approvals: could not tell ${interaction.user.username} "${content}":`, error);
  }
}

/** Takes the button off the report line (an answered or dead offer). Never throws. */
async function dropButton(interaction: ButtonInteraction, outcome?: string): Promise<void> {
  const content = outcome ? withOutcome(interaction.message.content ?? '', outcome) : undefined;
  const options = { ...(content !== undefined ? { content } : {}), components: [], allowedMentions: { parse: [] } };
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply(options);
    else await interaction.update(options);
  } catch (error) {
    logger.warn('approvals: could not update the report line:', error);
  }
}

/** A bookkeeping write after the claim; a failure is logged (the worst case is a button that says "busy" for 5 min). */
function settle(what: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    logger.warn(`approvals: ${what} failed:`, error);
  }
}

/** Handles a Confirm click. Never throws. */
export async function handleApprovalClick(interaction: ButtonInteraction, deps: ApprovalDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const id = parseApprovalCustomId(interaction.customId);
  if (id === undefined) {
    await tellPrivately(interaction, APPROVAL_LINES.unknown);
    return;
  }

  const owner = await ownerWithin(deps.isOwner(interaction.client, interaction.user.id));
  if (owner !== true) {
    await tellPrivately(interaction, owner === undefined ? APPROVAL_LINES.ownerUnknown : APPROVAL_LINES.notOwner);
    return;
  }

  let claim: ReturnType<typeof claimApproval>;
  try {
    claim = claimApproval(id, now());
  } catch (error) {
    logger.warn(`approvals: claiming #${id} failed:`, error);
    await tellPrivately(interaction, APPROVAL_LINES.failed);
    return;
  }
  switch (claim.status) {
    case 'busy':
      await tellPrivately(interaction, APPROVAL_LINES.busy);
      return;
    case 'done':
      await dropButton(interaction);
      await tellPrivately(interaction, APPROVAL_LINES.alreadyDone);
      return;
    case 'unknown':
      await dropButton(interaction);
      await tellPrivately(interaction, APPROVAL_LINES.unknown);
      return;
    case 'expired':
      await dropButton(interaction, APPROVAL_LINES.expired);
      return;
  }

  const { approval } = claim;
  try {
    await interaction.deferUpdate();
  } catch (error) {
    // Discord didn't take the acknowledgement (the token expired, an outage): nothing was done yet.
    settle(`releasing #${id}`, () => releaseApproval(id));
    logger.warn(`approvals: acknowledging the click on #${id} failed:`, error);
    return;
  }

  let result: ApprovalResult;
  try {
    result = await deps.execute(approval.payload, interaction.client);
  } catch (error) {
    logger.warn(`approvals: #${id} (${approval.payload.kind}) failed:`, error);
    result = { status: 'retry', note: APPROVAL_LINES.failed };
  }

  if (result.status === 'retry') {
    settle(`releasing #${id}`, () => releaseApproval(id));
    await tellPrivately(interaction, result.note);
    return;
  }
  settle(`closing #${id}`, () => completeApproval(id, interaction.user.id, now()));
  logger.info(
    `approvals: ${interaction.user.username} confirmed #${id} (${approval.payload.kind}, ${result.status}): ${result.note}`,
  );
  const outcome =
    result.status === 'done' ? `✅ ${result.note} · approved by <@${interaction.user.id}>` : `✖ ${result.note}`;
  await dropButton(interaction, outcome);
}
