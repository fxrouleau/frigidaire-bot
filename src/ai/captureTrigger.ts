// When the learner reads a channel (memory v2 capture, docs/memory.md): the schedule, kept apart from the
// extraction in personalityLearner.ts. The learner reports every member message to its trigger
// (noteActivity), asks it every `tickMs` which channels are due (takeDue), and reads each due channel from
// its watermark. A channel it takes is forgotten by the trigger until new activity arrives; a tick that
// finds the previous capture still running takes nothing, so pending channels simply wait.
//
// IntervalCaptureTrigger is the original cadence (every LEARNING_INTERVAL_MS, every channel that saw
// activity). Memory v2's conversation-end trigger (a channel is due once it has been quiet for
// CAPTURE_IDLE_MINUTES, or its oldest uncaptured message is CAPTURE_MAX_SPAN_MINUTES old, on a 1-minute
// tick) implements the same interface.
import { config } from '../config';

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
   * The channels due for capture at `now` (epoch ms), in the order to read them. Taking a channel forgets
   * its pending activity: messages posted after this call count toward the next capture.
   */
  takeDue(now: number): string[];
}

/** The original cadence: at every tick, every channel that saw member activity since it was last taken. */
export class IntervalCaptureTrigger implements CaptureTrigger {
  readonly tickMs: number;
  private readonly pending = new Set<string>();

  constructor(intervalMs: number = config.learner.intervalMs) {
    this.tickMs = intervalMs;
  }

  describe(): string {
    return `every ${Math.round(this.tickMs / 1000)}s`;
  }

  noteActivity(activity: CaptureActivity): void {
    this.pending.add(activity.channelId);
  }

  takeDue(_now: number): string[] {
    const due = [...this.pending];
    this.pending.clear();
    return due;
  }
}
