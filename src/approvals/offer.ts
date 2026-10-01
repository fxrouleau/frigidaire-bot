// Posting a shadow line with its Confirm button. The line goes to the report channel exactly as before;
// the button's custom_id (`sa:<row id>`) points at the bot.db row holding what Confirm does.
import {
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  ButtonStyle,
  type Client,
  ComponentType,
} from 'discord.js';
import { sendToReportChannel } from '../ai/reportChannel';
import { easternParts, easternWallClockToDate } from '../ai/utils';
import { logger } from '../logger';
import { type ApprovalPayload, createApproval, deleteApproval } from './approvalStore';

const CUSTOM_ID_PREFIX = 'sa:';
const CUSTOM_ID = /^sa:(\d{1,15})$/;
const REACTION_TTL_MS = 24 * 60 * 60_000;

const BUTTON_LABELS: Record<ApprovalPayload['kind'], string> = {
  birthday: 'Post it',
  auto_react: 'React',
};

export function approvalCustomId(id: number): string {
  return `${CUSTOM_ID_PREFIX}${id}`;
}

export function isApprovalCustomId(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

/** The row id a button carries; undefined for a malformed custom_id. */
export function parseApprovalCustomId(customId: string): number | undefined {
  const match = customId.match(CUSTOM_ID);
  return match ? Number(match[1]) : undefined;
}

/**
 * Until when Confirm may act. A birthday: the end of its Eastern day (the announcer never wishes anyone a
 * happy birthday the day after either). A reaction: a day, so an old post doesn't get one out of nowhere.
 */
export function approvalExpiry(payload: ApprovalPayload, now: number): number {
  if (payload.kind === 'auto_react') return now + REACTION_TTL_MS;
  const today = easternParts(new Date(now));
  return easternWallClockToDate(today.year, today.month, today.day + 1).getTime();
}

export function approvalButtonRow(
  id: number,
  kind: ApprovalPayload['kind'],
): APIActionRowComponent<APIButtonComponentWithCustomId> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        custom_id: approvalCustomId(id),
        label: BUTTON_LABELS[kind],
        style: ButtonStyle.Success,
      },
    ],
  };
}

/**
 * Posts a shadow line to the report channel with a Confirm button for `payload`. Resolves like
 * sendToReportChannel (true when it posted). Never throws: when the offer can't be stored, the line still
 * goes out, without a button.
 */
export async function offerApproval(
  client: Client,
  text: string,
  payload: ApprovalPayload,
  now = Date.now(),
): Promise<boolean> {
  let id: number;
  try {
    id = createApproval(payload, now, approvalExpiry(payload, now));
  } catch (error) {
    logger.warn('approvals: could not store a shadow approval; posting the line without a button:', error);
    return sendToReportChannel(client, text);
  }
  const posted = await sendToReportChannel(client, text, { components: [approvalButtonRow(id, payload.kind)] });
  if (!posted) {
    try {
      deleteApproval(id);
    } catch (error) {
      logger.warn(`approvals: could not remove unposted approval ${id}:`, error);
    }
  }
  return posted;
}
