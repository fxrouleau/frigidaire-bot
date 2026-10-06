// When the nightly dream runs, and what it tells the owner (docs/memory.md "Dreaming"). Once per Eastern
// day, on the first check at or after MEMORY_DREAM_HOUR (4): a bot that was down at 4 catches up the same
// day, and a day that already ran (or started to) never runs again. The day is claimed in memory.db's
// bot_state BEFORE the run, so a night that crashes or fails is not retried the same day: its people are
// still above their watermarks and wait for the next night. While another process dreams over the same
// memory.db (a `memory bootstrap --run` catching up: dreamLease.ts), the day stays unclaimed and the night
// runs on the first check after it is done. After a night that changed notes (or failed
// for someone), a report goes to the report channel (MEMORY_DREAM_REPORT), never pinging anyone: a header,
// then one line per owner, the change summaries in full (they are capped at 300 characters already; GLM
// writes whole sentences, and an 80-character clip cut nearly every one mid-word):
//
//   🌙 dream · Sep 26 · 2 updated · 1 failed, retried tomorrow · $0.18
//   • Remi [profile, work]: new job at the bakery
//   • the group [lore]: new lore: the 2026 LAN
//   📖 rewritten as history: Ski trip
//   🗄 archived 6 circles: yugioh, mtg, … · 1 occasion: orchard-trip
//   ✖ Dale: "profile" too long (4,105 of 4,000) · last good dream Sep 20
//
// The lifecycle lines come from the lifecycle pass after the dreams (dreamer.ts runLifecycle).
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
import {
  type DreamOutcome,
  type LifecycleOutcome,
  type NightlyDreamResult,
  noteLabel,
  runNightlyDream,
} from './dreamer';
import { type DreamLeaseHolder, type DreamLeaseResult, takeDreamLease } from './dreamLease';
import { easternDay, easternDayOf } from './dreamPrompts';
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
/** Owners given a line of their own in the report (more than a night dreams); the rest are counted. */
const REPORT_MAX_LINES = 25;
/** A failure's reason, when it is none of the known ones. */
const REPORT_REASON_CHARS = 120;

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

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Sep 26" for an Eastern day (YYYY-MM-DD). */
function shortDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : SHORT_DATE.format(date);
}

const count = (n: string) => Number(n).toLocaleString('en-US');

/** Why a dream failed, in a few words: the size refusal with its numbers, a bad answer, an API error. */
export function failureReason(error: string): string {
  const size = /(note|circle) "([^"]+)": the content is (\d+) characters, over the (\d+) limit/.exec(error);
  if (size)
    return `${size[1] === 'circle' ? 'circle ' : ''}"${size[2]}" too long (${count(size[3])} of ${count(size[4])})`;
  if (error.includes('not a JSON object')) return 'the answer was not JSON';
  if (error.includes('cut off at the length limit')) return 'the answer was cut off';
  if (error.includes('the answer was empty')) return 'the answer was empty';
  if (error.includes("the provider's content filter")) return "blocked by the provider's content filter";
  if (error.includes('the notes changed while dreaming'))
    return 'the notes changed while it dreamed (an edit came first)';
  if (error.includes('the profile lost its')) return 'the rewrite dropped profile sections';
  if (error.includes('the profile shrank from')) return 'the rewrite lost half the profile';
  return clip(error.split('; ')[0], REPORT_REASON_CHARS);
}

/** "last good dream Sep 20"; without a dream yet, "notes from Sep 27" (an import) or "no notes yet"; '' when unknown. */
function lastGood(outcome: Extract<DreamOutcome, { status: 'failed' }>): string {
  const day = (at: string | undefined) => (at ? easternDayOf(at) : undefined);
  const dreamed = day(outcome.lastDreamAt ?? undefined);
  if (dreamed) return ` · last good dream ${shortDay(dreamed)}`;
  if (outcome.lastDreamAt !== null) return '';
  const written = day(outcome.notesUpdatedAt);
  return written ? ` · notes from ${shortDay(written)}, no good dream since` : ' · no notes yet';
}

/** What a dream wrote, like the log line: `profile, food, circle:mtg, occasion:ski-trip-2027, -games`. */
function touched(outcome: Extract<DreamOutcome, { status: 'updated' }>): string {
  return [...outcome.written.map(noteLabel), ...outcome.removed.map((n) => `-${noteLabel(n)}`)].join(', ');
}

/** `6 circles: yugioh, mtg, …` (at most LIFECYCLE_NAMES slugs shown). */
const LIFECYCLE_NAMES = 12;
function countedSlugs(slugs: string[], one: string, many: string): string {
  const shown = slugs.slice(0, LIFECYCLE_NAMES).join(', ');
  const more = slugs.length > LIFECYCLE_NAMES ? `, … ${slugs.length - LIFECYCLE_NAMES} more` : '';
  return `${slugs.length} ${slugs.length === 1 ? one : many}: ${shown}${more}`;
}

/**
 * The lifecycle report lines: rewrites as history, revivals, archives, failures, what waits, and the
 * circles fading.
 */
function lifecycleLines(result: NightlyDreamResult): string[] {
  const outcomes = result.lifecycle ?? [];
  const deferred = result.lifecycleDeferred ?? 0;
  const lines: string[] = [];
  const history = outcomes.filter((o): o is Extract<LifecycleOutcome, { status: 'history' }> => o.status === 'history');
  if (history.length > 0) {
    const titles = history.map((o) => (o.note.status === 'cancelled' ? `${o.note.title} (called off)` : o.note.title));
    lines.push(`📖 rewritten as history: ${titles.join(', ')}`);
  }
  if (result.revived && result.revived.length > 0) {
    lines.push(`↩ came back: ${countedSlugs(result.revived, 'circle', 'circles')}`);
  }
  const archived = outcomes.filter(
    (o): o is Extract<LifecycleOutcome, { status: 'archived' }> => o.status === 'archived',
  );
  const circles = archived.filter((o) => o.note.scope === 'circle').map((o) => o.note.topic);
  const occasions = archived.filter((o) => o.note.scope === 'occasion').map((o) => o.note.topic);
  const parts = [
    circles.length > 0 ? countedSlugs(circles, 'circle', 'circles') : '',
    occasions.length > 0 ? countedSlugs(occasions, 'occasion', 'occasions') : '',
  ].filter((p) => p);
  if (parts.length > 0) lines.push(`🗄 archived ${parts.join(' · ')}`);
  for (const o of outcomes) {
    if (o.status !== 'failed') continue;
    const what = o.task === 'history' ? "couldn't rewrite it as history" : "couldn't archive it";
    lines.push(`✖ ${o.scope} ${o.slug}: ${what} (${clip(o.error, REPORT_REASON_CHARS)})`);
  }
  if (deferred > 0) lines.push(`-# ${deferred} more to archive or rewrite wait for the next nights`);
  if (result.fading && result.fading.length > 0) {
    lines.push(`🍂 fading: ${countedSlugs(result.fading, 'circle', 'circles')}`);
  }
  return lines;
}

/** `$0.18`; `<$0.01` for a few tenths of a cent. */
export function formatUsd(cost: number): string {
  return cost > 0 && cost < 0.005 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

function ownerName(outcome: DreamOutcome, nameOf: (userId: string) => string | undefined): string {
  return outcome.owner.scope === 'group' ? 'the group' : (nameOf(outcome.owner.ownerId) ?? 'someone');
}

/**
 * The report for a night: a header (the day, how many owners were updated, unchanged or failed, the cost),
 * then a line per updated owner (what it wrote, the change summary) and per failure (why, and since when
 * they have had no good dream). Undefined when nothing changed and nothing failed (no post). Long reports
 * are split on lines by the report channel.
 */
export function formatDreamReport(
  result: NightlyDreamResult,
  nameOf: (userId: string) => string | undefined,
): string | undefined {
  const owners = [...result.people, ...(result.group ? [result.group] : [])];
  const updated = owners.filter((o): o is Extract<DreamOutcome, { status: 'updated' }> => o.status === 'updated');
  const failed = owners.filter((o): o is Extract<DreamOutcome, { status: 'failed' }> => o.status === 'failed');
  const unchanged = owners.filter((o) => o.status === 'unchanged').length;
  const lifecycle = result.lifecycle ?? [];
  const lifecycleFailed = lifecycle.filter((o) => o.status === 'failed').length;
  // Circles merely fading never make a report on their own (they would every night).
  const changed = updated.length + failed.length + lifecycle.length + (result.revived?.length ?? 0);
  if (changed === 0) return undefined;

  const header = [`🌙 dream · ${shortDay(result.day)}`];
  if (updated.length > 0) header.push(`${updated.length} updated`);
  if (unchanged > 0) header.push(`${unchanged} unchanged`);
  if (failed.length + lifecycleFailed > 0) header.push(`${failed.length + lifecycleFailed} failed, retried tomorrow`);
  if (result.costUsd !== undefined) header.push(formatUsd(result.costUsd));

  const lines = [
    ...updated.map((o) => {
      const what = touched(o);
      return `• ${ownerName(o, nameOf)}${what ? ` [${what}]` : ''}: ${o.changeSummary.trim() || '(no summary)'}`;
    }),
    ...failed.map((o) => `✖ ${ownerName(o, nameOf)}: ${failureReason(o.error)}${lastGood(o)}`),
    ...lifecycleLines(result),
  ];
  const shown = lines.slice(0, REPORT_MAX_LINES);
  const more = lines.length > shown.length ? [`… and ${lines.length - shown.length} more`] : [];
  return [header.join(' · '), ...shown, ...more].join('\n');
}

/** The night's one log line. */
function summaryLine(result: NightlyDreamResult): string {
  const count = (status: DreamOutcome['status']) => result.people.filter((o) => o.status === status).length;
  const group = result.group ? `; group ${result.group.status}` : '';
  const steps = result.lifecycle ?? [];
  const step = (status: LifecycleOutcome['status']) => steps.filter((o) => o.status === status).length;
  const lifecycle =
    steps.length > 0
      ? `; lifecycle: ${step('history')} rewritten as history, ${step('archived')} archived, ${step('failed')} failed`
      : '';
  const cost = result.costUsd !== undefined ? ` · ${formatUsd(result.costUsd)}` : '';
  return `dream: night ${result.day} done: ${count('updated')} updated, ${count('unchanged')} unchanged, ${count('failed')} failed${group}${lifecycle}${cost}`;
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
