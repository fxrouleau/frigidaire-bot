// Posts due reminders. Called by the scheduler on every tick; everything it needs (client, clock,
// process start time, fallback channel) comes in through the options so tests drive it directly.
import type { Client } from 'discord.js';
import { logger } from '../logger';
import { type PostableChannel, describeError, fetchPostableChannel, isPermanentChannelError } from './discord';
import { currentName } from './people';
import { type Reminder, claimDueReminders, markFailed, markRetry, markSent, releaseStaleClaims } from './reminderStore';
import { clockEt, describeEt } from './time';

const MINUTE_MS = 60_000;
/** A reminder posted this long after its due time says so. */
const LATE_NOTE_MS = 5 * MINUTE_MS;
/** A reminder that came due before the process started, posted more than this late, was missed offline. */
const OFFLINE_GRACE_MS = MINUTE_MS;
/** Retry delays after a failed send (attempt 1, 2, …); the attempt after the last one is final. */
const RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 60 * MINUTE_MS];
export const MAX_SEND_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A 'sending' claim older than this belongs to a process that died mid-send. */
export const STALE_CLAIM_MS = 5 * MINUTE_MS;
const BATCH_SIZE = 20;

export type ReminderDeliveryOptions = {
  client: Client;
  now: number;
  /** When this process started delivering: reminders due before it were missed while offline. */
  startedAt: number;
  /** Where a reminder goes when its own channel is gone or unpostable (MAIN_CHANNEL_ID). */
  fallbackChannelId?: string;
};

export type DeliveryReport = { sent: number; retried: number; failed: number };

/** The reminder post: the ping line, then a subtext line with who set it and where. */
export function renderReminder(
  reminder: Reminder,
  opts: { now: number; startedAt: number; redirectedFrom?: string },
): string {
  const targets = reminder.targetIds.length > 0 ? reminder.targetIds : [reminder.requesterId];
  const mentions = targets.map((id) => `<@${id}>`).join(' ');

  const lateMs = opts.now - reminder.dueAt;
  const missedOffline = reminder.dueAt < opts.startedAt && lateMs > OFFLINE_GRACE_MS;
  const lateNote = missedOffline ? ' (late — I was offline)' : lateMs > LATE_NOTE_MS ? ' (late)' : '';

  const footer = [`set by ${currentName(reminder.requesterId, reminder.requesterName)}`];
  if (reminder.sourceUrl) footer.push(reminder.sourceUrl);
  if (lateNote) {
    const due = new Date(reminder.dueAt);
    footer.push(`was due ${lateMs > 12 * 60 * MINUTE_MS ? describeEt(due) : `${clockEt(due)} ET`}`);
  }
  if (opts.redirectedFrom) footer.push(`couldn't post in <#${opts.redirectedFrom}>`);

  return `⏰ ${mentions} ${reminder.text}${lateNote}\n-# ${footer.join(' · ')}`;
}

async function post(channel: PostableChannel, reminder: Reminder, content: string): Promise<string> {
  const targets = reminder.targetIds.length > 0 ? reminder.targetIds : [reminder.requesterId];
  const message = await channel.send({
    content,
    // Only the reminder's own people get pinged: an @everyone or a stray <@id> inside the text stays inert.
    allowedMentions: { parse: [], users: targets },
    // Idempotency for a re-send after a crash between Discord accepting the post and the row being
    // marked sent: Discord returns the earlier message instead of posting again (a few-minute window).
    nonce: `reminder-${reminder.id}`,
    enforceNonce: true,
  });
  return message.id;
}

async function deliver(
  reminder: Reminder,
  opts: ReminderDeliveryOptions,
): Promise<{ messageId: string; channelId: string }> {
  try {
    const channel = await fetchPostableChannel(opts.client, reminder.channelId);
    const content = renderReminder(reminder, opts);
    return { messageId: await post(channel, reminder, content), channelId: channel.id };
  } catch (error) {
    const fallback = opts.fallbackChannelId;
    if (!fallback || fallback === reminder.channelId || !isPermanentChannelError(error)) throw error;
    logger.warn(
      `reminders: #${reminder.id} can't be posted in ${reminder.channelId} (${describeError(error)}); using the main channel.`,
    );
    const channel = await fetchPostableChannel(opts.client, fallback);
    const content = renderReminder(reminder, { ...opts, redirectedFrom: reminder.channelId });
    return { messageId: await post(channel, reminder, content), channelId: channel.id };
  }
}

/** Posts every due reminder once. Never throws: failures are retried with backoff, then marked failed. */
export async function deliverDueReminders(opts: ReminderDeliveryOptions): Promise<DeliveryReport> {
  const report: DeliveryReport = { sent: 0, retried: 0, failed: 0 };

  const released = releaseStaleClaims(opts.now, STALE_CLAIM_MS);
  if (released > 0) logger.warn(`reminders: released ${released} stale delivery claim(s) from a previous run.`);

  for (const reminder of claimDueReminders(opts.now, BATCH_SIZE)) {
    try {
      const posted = await deliver(reminder, opts);
      markSent(reminder.id, { ...posted, at: opts.now });
      report.sent++;
      logger.info(`reminders: delivered #${reminder.id} to ${posted.channelId}.`);
    } catch (error) {
      const reason = describeError(error);
      if (reminder.attempts >= MAX_SEND_ATTEMPTS) {
        markFailed(reminder.id, reason);
        report.failed++;
        logger.warn(`reminders: giving up on #${reminder.id} after ${reminder.attempts} attempts: ${reason}`);
      } else {
        const delay = RETRY_DELAYS_MS[reminder.attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        markRetry(reminder.id, reason, opts.now + delay);
        report.retried++;
        logger.warn(`reminders: delivering #${reminder.id} failed (attempt ${reminder.attempts}), retrying: ${reason}`);
      }
    }
  }
  return report;
}
