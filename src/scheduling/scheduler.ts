// One timer drives every scheduled post: due reminders and the daily birthday announcement. Each job
// has its own in-flight guard, so a slow birthday model call never holds up a reminder and a tick that
// overlaps a still-running one simply skips that job. All state lives in bot.db, so a restart loses
// nothing: the first tick after ClientReady posts whatever came due while the bot was down.
import type { Client } from 'discord.js';
import { config } from '../config';
import { logger } from '../logger';
import { BirthdayAnnouncer, type BirthdayWriter } from './birthdayAnnouncer';
import { applySeed } from './birthdayStore';
import { deliverDueReminders } from './reminderDelivery';
import { pruneFinished } from './reminderStore';
import { easternDate } from './time';

export const SCHEDULER_TICK_MS = 30_000;
/** Finished reminders (sent/failed/cancelled) are kept this long for list/cancel answers, then deleted. */
const FINISHED_REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SchedulerOptions = {
  client: Client;
  now?: () => number;
  tickMs?: number;
  birthdayWriter?: BirthdayWriter;
};

export class Scheduler {
  private readonly client: Client;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly birthdays: BirthdayAnnouncer;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | undefined;
  private remindersRunning = false;
  private birthdaysRunning = false;

  constructor(opts: SchedulerOptions) {
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? SCHEDULER_TICK_MS;
    this.birthdays = new BirthdayAnnouncer({ client: opts.client, writer: opts.birthdayWriter });
    this.startedAt = this.now();
  }

  /** Startup maintenance, one immediate tick, then the interval. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.maintenance();
    void this.tick();
    // unref(): the timer must never keep the process alive on its own.
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs both jobs (concurrently, each at most once at a time). Never rejects. */
  async tick(): Promise<void> {
    await Promise.all([this.runReminders(), this.runBirthdays()]);
  }

  private maintenance(): void {
    const now = this.now();
    try {
      const pruned = pruneFinished(now, FINISHED_REMINDER_RETENTION_MS);
      if (pruned > 0) logger.info(`reminders: pruned ${pruned} finished reminder(s).`);
    } catch (error) {
      logger.warn('reminders: pruning finished reminders failed:', error);
    }
    try {
      const seeded = applySeed(config.birthdays.seed, new Date(now), easternDate(new Date(now)));
      if (seeded.added > 0) logger.info(`birthdays: seeded ${seeded.added} birthday(s) from BIRTHDAYS_SEED.`);
    } catch (error) {
      logger.warn('birthdays: applying BIRTHDAYS_SEED failed:', error);
    }
  }

  private async runReminders(): Promise<void> {
    if (this.remindersRunning) return;
    this.remindersRunning = true;
    try {
      await deliverDueReminders({
        client: this.client,
        now: this.now(),
        startedAt: this.startedAt,
        fallbackChannelId: config.server.mainChannelId,
      });
    } catch (error) {
      logger.warn('reminders: delivery tick failed:', error);
    } finally {
      this.remindersRunning = false;
    }
  }

  private async runBirthdays(): Promise<void> {
    if (this.birthdaysRunning) return;
    this.birthdaysRunning = true;
    try {
      await this.birthdays.run(this.now());
    } catch (error) {
      logger.warn('birthdays: announcement tick failed:', error);
    } finally {
      this.birthdaysRunning = false;
    }
  }
}
