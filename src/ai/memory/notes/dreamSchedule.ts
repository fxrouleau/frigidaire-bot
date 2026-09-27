// When the nightly dream runs, and what it tells the owner (docs/memory.md "Dreaming"). Once per Eastern
// day, on the first check at or after MEMORY_DREAM_HOUR (4): a bot that was down at 4 catches up the same
// day, and a day that already ran (or started to) never runs again. The day is claimed in memory.db's
// bot_state BEFORE the run, so a night that crashes or fails is not retried the same day: its people are
// still above their watermarks and wait for the next night. While another process dreams over the same
// memory.db (a `memory bootstrap --run` catching up: dreamLease.ts), the day stays unclaimed and the night
// runs on the first check after it is done. After a night that changed notes (or failed
// for someone), one line goes to the report channel (MEMORY_DREAM_REPORT), never pinging anyone:
//
//   🌙 dream · updated 2 profiles (Remi: new job at the bakery; Dale: quit Valorant) · group: new lore · $0.18
//
// After each night the notes' version history is trimmed to the newest 50 versions per note (bootstrap and
// owner-edit versions are always kept). The check is one bot_state read, so it simply runs every minute
// (unref'd timers, started by the memoryDream ClientReady event).
import type { Client } from 'discord.js';
import { config } from '../../../config';
import { canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import { getReportChannelId, sendToReportChannel } from '../../reportChannel';
import { easternParts } from '../../utils';
import { getMemoryStore, getNotesStore } from '../index';
import { type DreamOutcome, type NightlyDreamResult, runNightlyDream } from './dreamer';
import { type DreamLeaseHolder, type DreamLeaseResult, takeDreamLease } from './dreamLease';
import { easternDay } from './dreamPrompts';
import { NOTE_VERSIONS_KEPT } from './notesStore';

/** bot_state key: the Eastern day (YYYY-MM-DD) whose dream last ran (or started). */
export const DREAM_NIGHT_KEY = 'dream:last_night';
/** How often the schedule is checked. */
export const DREAM_TICK_MS = 60_000;
/**
 * The first check after startup waits a little: startup maintenance and a bootstrap import (which sets the
 * watermarks) come first.
 */
export const DREAM_FIRST_CHECK_DELAY_MS = 5 * 60_000;
/** People named in the report line; the rest are counted. */
const REPORT_MAX_NAMED = 8;
/** Each person's change summary in the report line. */
const REPORT_SUMMARY_CHARS = 80;

/** Where the once-a-day watermark lives (memory.db's bot_state by default). */
export type DreamStateStore = { get(key: string): string | undefined; set(key: string, value: string): void };

/**
 * The Eastern day whose dream is due at `now`, or undefined: not before `hour` (Eastern), and not when that
 * day (or a later one, after a clock change) already ran.
 */
export function dueNight(now: Date, hour: number, lastNight: string | undefined): string | undefined {
  if (easternParts(now).hour < hour) return undefined;
  const day = easternDay(now);
  return lastNight !== undefined && lastNight >= day ? undefined : day;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** `$0.18`; `<$0.01` for a few tenths of a cent. */
export function formatUsd(cost: number): string {
  return cost > 0 && cost < 0.005 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

function ownerName(outcome: DreamOutcome, nameOf: (userId: string) => string | undefined): string {
  return outcome.owner.scope === 'group' ? 'the group' : (nameOf(outcome.owner.ownerId) ?? 'someone');
}

/**
 * The report-channel line for a night: who was updated and what changed, the group, how many were
 * unchanged or failed, and the night's cost. Undefined when nothing changed and nothing failed (no post).
 */
export function formatDreamReport(
  result: NightlyDreamResult,
  nameOf: (userId: string) => string | undefined,
): string | undefined {
  const updated = result.people.filter(
    (o): o is Extract<DreamOutcome, { status: 'updated' }> => o.status === 'updated',
  );
  const unchanged = result.people.filter((o) => o.status === 'unchanged').length;
  const failed = [...result.people, ...(result.group ? [result.group] : [])].filter((o) => o.status === 'failed');
  const group = result.group?.status === 'updated' ? result.group : undefined;
  if (updated.length === 0 && !group && failed.length === 0) return undefined;

  const parts = ['🌙 dream'];
  if (updated.length > 0) {
    const named = updated
      .slice(0, REPORT_MAX_NAMED)
      .map((o) => `${ownerName(o, nameOf)}: ${clip(o.changeSummary || 'updated', REPORT_SUMMARY_CHARS)}`);
    const more = updated.length > REPORT_MAX_NAMED ? `; +${updated.length - REPORT_MAX_NAMED} more` : '';
    parts.push(`updated ${updated.length} profile${updated.length === 1 ? '' : 's'} (${named.join('; ')}${more})`);
  }
  if (group) parts.push(`group: ${clip(group.changeSummary || 'updated', REPORT_SUMMARY_CHARS)}`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  if (failed.length > 0) {
    parts.push(`${failed.length} failed (${failed.map((o) => ownerName(o, nameOf)).join(', ')}; retried tomorrow)`);
  }
  if (result.costUsd !== undefined) parts.push(formatUsd(result.costUsd));
  return parts.join(' · ');
}

/** The night's one log line. */
function summaryLine(result: NightlyDreamResult): string {
  const count = (status: DreamOutcome['status']) => result.people.filter((o) => o.status === status).length;
  const group = result.group ? `; group ${result.group.status}` : '';
  const cost = result.costUsd !== undefined ? ` · ${formatUsd(result.costUsd)}` : '';
  return `dream: night ${result.day} done: ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('failed')} failed${group}${cost}`;
}

export type DreamSchedulerOptions = {
  /** Runs one night (runNightlyDream over the shared stores by default). */
  run?: () => Promise<NightlyDreamResult>;
  /**
   * Takes the dream lease for the night (takeDreamLease on the shared memory store by default), so the
   * night never runs while another process on the same memory.db is dreaming.
   */
  lease?: () => DreamLeaseResult;
  /**
   * After the night: trims the notes' version history (NotesStore.pruneVersions on the shared store by
   * default); resolves how many versions went.
   */
  prune?: () => number;
  /** Posts the report line; resolves whether it went out. Without one, nothing is posted. */
  report?: (text: string) => Promise<boolean>;
  state?: DreamStateStore;
  /** Current display names for the report line. */
  nameOf?: (userId: string) => string | undefined;
  now?: () => Date;
};

function defaultState(): DreamStateStore {
  const store = getMemoryStore();
  return { get: (key) => store.getState(key), set: (key, value) => store.setState(key, value) };
}

/** The holder label of the nightly dream's lease (what another process is told). */
export const NIGHTLY_DREAM_HOLDER = 'the nightly dream';

function defaultLease(): DreamLeaseResult {
  return takeDreamLease(getMemoryStore(), NIGHTLY_DREAM_HOLDER);
}

function defaultNameOf(userId: string): string | undefined {
  return getMemoryStore().getIdentityById(canonicalUserId(userId))?.display_name;
}

/** Runs the nightly dream once per Eastern day. */
export class DreamScheduler {
  private running = false;
  /** The other holder last logged as dreaming, so a wait is logged once, not every tick. */
  private waitingFor: string | undefined;
  private firstCheck: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly opts: DreamSchedulerOptions = {}) {}

  /**
   * Runs the day's dream when it is due (MEMORY_DREAM_ENABLED, at/after MEMORY_DREAM_HOUR Eastern, not yet
   * run today, not already running here or in another process: the dream lease), then logs and reports it.
   * Resolves with the night's result, or undefined when nothing ran. Never throws.
   */
  async check(): Promise<NightlyDreamResult | undefined> {
    if (!config.dream.enabled || this.running) return undefined;
    this.running = true;
    try {
      const state = this.opts.state ?? defaultState();
      const now = (this.opts.now ?? (() => new Date()))();
      const night = dueNight(now, config.dream.hour, state.get(DREAM_NIGHT_KEY));
      if (!night) return undefined;
      // Someone else is dreaming (a bootstrap catching up): the day stays unclaimed, tried again next tick.
      const taken = (this.opts.lease ?? defaultLease)();
      if (!taken.ok) {
        this.noteWaiting(night, taken.heldBy);
        return undefined;
      }
      this.waitingFor = undefined;
      try {
        // Claimed first: never twice a day, even when the run below crashes or fails.
        state.set(DREAM_NIGHT_KEY, night);
        const run = this.opts.run ?? (() => runNightlyDream({ notes: getNotesStore(), memory: getMemoryStore() }));
        const result = await run();
        logger.info(summaryLine(result));
        await this.report(result);
        this.prune();
        return result;
      } finally {
        taken.lease.release();
      }
    } catch (error) {
      logger.warn('dream: the nightly check failed:', error);
      return undefined;
    } finally {
      this.running = false;
    }
  }

  private noteWaiting(night: string, heldBy: DreamLeaseHolder): void {
    const key = `${heldBy.holder}@${heldBy.since}`;
    if (this.waitingFor === key) return;
    this.waitingFor = key;
    logger.info(
      `dream: ${heldBy.holder} has been running since ${heldBy.since} (Eastern); the night of ${night} waits until it is done.`,
    );
  }

  /** Trims the notes' version history after the night; a failure is only logged. */
  private prune(): void {
    try {
      const removed = (this.opts.prune ?? (() => getNotesStore().pruneVersions()))();
      if (removed > 0) {
        logger.info(
          `dream: pruned ${removed} old note version(s) (each note keeps its newest ${NOTE_VERSIONS_KEPT}; bootstrap and owner-edit versions always).`,
        );
      }
    } catch (error) {
      logger.warn('dream: pruning old note versions failed:', error);
    }
  }

  private async report(result: NightlyDreamResult): Promise<void> {
    if (!config.dream.reportEnabled || !this.opts.report) return;
    const text = formatDreamReport(result, this.opts.nameOf ?? defaultNameOf);
    if (!text) return;
    if (!(await this.opts.report(text))) logger.warn('dream: the report-channel line did not go out.');
  }

  /**
   * Checks once DREAM_FIRST_CHECK_DELAY_MS after starting, then every DREAM_TICK_MS (the ticks only start
   * after that first check, so nothing runs during the startup delay). Idempotent; unref'd.
   */
  start(): void {
    if (this.firstCheck || this.interval) return;
    this.firstCheck = setTimeout(() => {
      this.firstCheck = undefined;
      void this.check();
      this.interval = setInterval(() => void this.check(), DREAM_TICK_MS);
      this.interval.unref?.();
    }, DREAM_FIRST_CHECK_DELAY_MS);
    this.firstCheck.unref?.();
  }

  stop(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck);
    if (this.interval) clearInterval(this.interval);
    this.firstCheck = undefined;
    this.interval = undefined;
  }
}

/** The production scheduler: the shared stores, the report channel when one is set. Started on ClientReady. */
export function startDreamScheduler(client: Client): DreamScheduler {
  // No report channel, no report line (and no nightly warning about it).
  const scheduler = new DreamScheduler(
    getReportChannelId() ? { report: (text) => sendToReportChannel(client, text) } : {},
  );
  scheduler.start();
  logger.info(
    `dream: scheduled daily from ${String(config.dream.hour).padStart(2, '0')}:00 Eastern (${config.dream.model}, up to ${config.dream.maxPeoplePerNight} people a night).`,
  );
  return scheduler;
}
