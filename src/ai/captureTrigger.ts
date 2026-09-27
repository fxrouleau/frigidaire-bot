// When the learner reads a channel (memory v2 capture, docs/memory.md): the schedule, kept apart from the
// extraction in personalityLearner.ts. The learner reports every member message to its trigger
// (noteActivity), asks it every `tickMs` which channels are due (takeDue), and reads each due channel from
// its watermark. A channel it takes is forgotten by the trigger until new activity arrives; a tick that
// finds the previous capture still running takes nothing, so pending channels simply wait.
//
// ConversationEndTrigger is memory v2's schedule (the one the bot runs, src/ai/learnerInstance.ts): a
// channel is due once it holds MIN_MESSAGES_FOR_OBSERVATION new member messages and has been quiet for
// CAPTURE_IDLE_MINUTES, or its oldest uncaptured message is CAPTURE_MAX_SPAN_MINUTES old (a conversation
// that never pauses), on a 1-minute tick. So the extractor reads whole conversations, not 30-minute
// slices of them. IntervalCaptureTrigger is the original cadence (every LEARNING_INTERVAL_MS, every channel
// that saw activity), kept for tests and as the fallback shape of the seam.
//
// Activity lives in memory. What a trigger cannot have seen (messages posted while the bot was down, or
// left over by a capture that stopped at its cap) is reported with noteBacklog(): the learner then reads
// the channel and counts the new messages itself.
import { config } from '../config';

const MINUTE_MS = 60_000;

/** One member message the learner may capture later (what the MessageCreate tracker knows about it). */
export type CaptureActivity = {
  channelId: string;
  /** When it was posted (epoch ms). */
  at: number;
  messageId?: string;
  /** The author's Discord id (a relay is never reported: the tracker skips webhooks and bots). */
  authorId?: string;
};

export interface CaptureTrigger {
  /** How often the learner asks takeDue() (ms). */
  readonly tickMs: number;
  /** One line for the learner's startup log, e.g. "every 30m" or "idle 20m, span 2h, tick 1m". */
  describe(): string;
  /** A member posted in a channel the learner reads (ignored channels never get here). */
  noteActivity(activity: CaptureActivity): void;
  /**
   * The channel may hold uncaptured messages noteActivity() never reported: posted while the bot was down
   * (the learner reports recently read channels at startup), or left over by a capture that stopped at its
   * message cap. Treated like activity at `at` whose count is unknown: the trigger schedules a read, and
   * the learner checks the minimum message count on what it fetches.
   */
  noteBacklog(channelId: string, at: number): void;
  /**
   * The channels due for capture at `now` (epoch ms), in the order to read them. Taking a channel forgets
   * its pending activity: messages posted after this call count toward the next capture.
   */
  takeDue(now: number): string[];
}

/** 1200000 → "20m", 7200000 → "2h", 90000 → "90s": for the startup log line. */
function formatDuration(ms: number): string {
  if (ms >= 60 * MINUTE_MS && ms % (60 * MINUTE_MS) === 0) return `${ms / (60 * MINUTE_MS)}h`;
  if (ms >= MINUTE_MS && ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** The original cadence: at every tick, every channel that saw member activity since it was last taken. */
export class IntervalCaptureTrigger implements CaptureTrigger {
  readonly tickMs: number;
  private readonly pending = new Set<string>();

  constructor(intervalMs: number = config.learner.intervalMs) {
    this.tickMs = intervalMs;
  }

  describe(): string {
    return `every ${formatDuration(this.tickMs)}`;
  }

  noteActivity(activity: CaptureActivity): void {
    this.pending.add(activity.channelId);
  }

  noteBacklog(channelId: string, _at: number): void {
    this.pending.add(channelId);
  }

  takeDue(_now: number): string[] {
    const due = [...this.pending];
    this.pending.clear();
    return due;
  }
}

export type ConversationEndOptions = {
  /** Quiet time after the last member message before a conversation counts as over (CAPTURE_IDLE_MINUTES). */
  idleMs?: number;
  /** A conversation that never pauses is read once its oldest uncaptured message is this old (CAPTURE_MAX_SPAN_MINUTES). */
  maxSpanMs?: number;
  /** New member messages a channel needs (MIN_MESSAGES_FOR_OBSERVATION); a backlog skips the count. */
  minMessages?: number;
  /** How often the learner asks (default 1 minute). */
  tickMs?: number;
};

/** A channel's uncaptured conversation, as far as the trigger knows it. */
type PendingConversation = {
  /** Member messages reported since the channel was last taken. */
  count: number;
  /** When the oldest of them was posted (or the backlog noted), epoch ms. */
  firstAt: number;
  /** When the newest was posted, epoch ms. */
  lastAt: number;
  /** Messages the trigger never saw may be waiting (see noteBacklog): the count is not known. */
  backlog: boolean;
};

/**
 * Memory v2's capture schedule: a channel is due at the end of a conversation. It needs `minMessages` new
 * member messages (or a backlog) and either `idleMs` of quiet since the last one or `maxSpanMs` since the
 * oldest one. Channels come out oldest conversation first.
 */
export class ConversationEndTrigger implements CaptureTrigger {
  readonly tickMs: number;
  readonly idleMs: number;
  readonly maxSpanMs: number;
  readonly minMessages: number;
  private readonly pending = new Map<string, PendingConversation>();

  constructor(opts: ConversationEndOptions = {}) {
    this.idleMs = opts.idleMs ?? config.learner.captureIdleMinutes * MINUTE_MS;
    this.maxSpanMs = opts.maxSpanMs ?? config.learner.captureMaxSpanMinutes * MINUTE_MS;
    this.minMessages = Math.max(1, opts.minMessages ?? config.learner.minMessages);
    this.tickMs = opts.tickMs ?? MINUTE_MS;
  }

  describe(): string {
    return `conversation end (idle ${formatDuration(this.idleMs)}, span ${formatDuration(this.maxSpanMs)}, min ${this.minMessages} messages, tick ${formatDuration(this.tickMs)})`;
  }

  noteActivity(activity: CaptureActivity): void {
    const pending = this.pending.get(activity.channelId);
    if (!pending) {
      this.pending.set(activity.channelId, { count: 1, firstAt: activity.at, lastAt: activity.at, backlog: false });
      return;
    }
    pending.count++;
    pending.firstAt = Math.min(pending.firstAt, activity.at);
    pending.lastAt = Math.max(pending.lastAt, activity.at);
  }

  noteBacklog(channelId: string, at: number): void {
    const pending = this.pending.get(channelId);
    if (!pending) {
      this.pending.set(channelId, { count: 0, firstAt: at, lastAt: at, backlog: true });
      return;
    }
    pending.backlog = true;
    pending.firstAt = Math.min(pending.firstAt, at);
    pending.lastAt = Math.max(pending.lastAt, at);
  }

  takeDue(now: number): string[] {
    const due = [...this.pending.entries()]
      .filter(([, pending]) => this.isDue(pending, now))
      .sort(([idA, a], [idB, b]) => a.firstAt - b.firstAt || (idA < idB ? -1 : idA > idB ? 1 : 0))
      .map(([channelId]) => channelId);
    for (const channelId of due) this.pending.delete(channelId);
    return due;
  }

  private isDue(pending: PendingConversation, now: number): boolean {
    if (pending.count < this.minMessages && !pending.backlog) return false;
    return now - pending.lastAt >= this.idleMs || now - pending.firstAt >= this.maxSpanMs;
  }
}
