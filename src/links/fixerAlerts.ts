// Report-channel alerts for link fixing: "every Instagram fixer is down" when a platform's whole fixer
// list stops working, and "Instagram links work again" when one recovers. The owner only finds out a
// hobby fixer died when someone complains about raw links, and the fix (reordering *_FIXERS) is one
// env var away — the alert says which.
//
// Rate limiting: a DOWN alert goes out at most once per LINK_FIX_ALERT_MIN_INTERVAL_MS per platform.
// A down verdict inside that window is not dropped but deferred to the window's end, and only posted
// if the platform is still down then, so a flapping fixer costs at most one outage/recovery pair per
// window while a real outage is always reported. A recovery only ever closes an outage that was
// announced (so it is bounded by the down alerts) and goes out immediately.
//
// What the channel was last told is persisted (bot.db), so a redeploy mid-outage neither re-announces
// the outage nor forgets to announce its end.
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import type { PlatformHealthChange, PlatformState } from './fixerHealth';
import { FIXER_ENV_VARS, PLATFORM_LABELS, type Platform } from './platforms';

/** What the report channel was last told about a platform, and when. */
export type AnnouncedState = { state: PlatformState; at: number };

export type AlertStore = {
  get(platform: Platform): AnnouncedState | undefined;
  set(platform: Platform, announced: AnnouncedState): void;
};

export type FixerAlerterOptions = {
  /** Posts to the report channel. Expected not to throw (sendToReportChannel logs its own failures). */
  send: (text: string) => Promise<void>;
  /** The platform's current verdict (fixerHealth.platformHealth); re-read when a deferred alert fires. */
  currentState: (platform: Platform) => PlatformState | 'unknown';
  minIntervalMs: number;
  store?: AlertStore;
  now?: () => number;
  /** Schedules a deferred re-check; returns its canceller. Defaults to an unref'd setTimeout. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS link_fix_alerts (
    platform    TEXT    PRIMARY KEY,
    state       TEXT    NOT NULL,
    alerted_at  INTEGER NOT NULL
  );
`;

/** The persisted store: one row per platform in bot.db. Failures are logged; alerts then run from memory. */
export function botDbAlertStore(): AlertStore {
  const memory = new Map<Platform, AnnouncedState>();
  const db = () => {
    const botDb = getBotDb();
    botDb.ensureSchema('link_fix_alerts', SCHEMA);
    return botDb;
  };
  return {
    get(platform) {
      try {
        const row = db().stmt('SELECT state, alerted_at FROM link_fix_alerts WHERE platform = ?').get(platform) as
          | { state: string; alerted_at: number }
          | undefined;
        if (row && (row.state === 'up' || row.state === 'down')) return { state: row.state, at: row.alerted_at };
      } catch (error) {
        logger.warn(`linkfix: could not read the alert state for ${platform}:`, error);
      }
      return memory.get(platform);
    },
    set(platform, announced) {
      memory.set(platform, announced);
      try {
        db()
          .stmt(
            `INSERT INTO link_fix_alerts (platform, state, alerted_at) VALUES (?, ?, ?)
             ON CONFLICT(platform) DO UPDATE SET state = excluded.state, alerted_at = excluded.alerted_at`,
          )
          .run(platform, announced.state, announced.at);
      } catch (error) {
        logger.warn(`linkfix: could not persist the alert state for ${platform}:`, error);
      }
    },
  };
}

export function memoryAlertStore(): AlertStore {
  const states = new Map<Platform, AnnouncedState>();
  return {
    get: (platform) => states.get(platform),
    set: (platform, announced) => {
      states.set(platform, announced);
    },
  };
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

/** "3 h 5 min", "2 d 4 h", "12 min" — coarse on purpose, it's an outage length. */
export function formatOutageDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

export function downAlertText(platform: Platform, detail: string): string {
  const label = PLATFORM_LABELS[platform];
  return [
    `⚠️ **${label} link fixing is down**: no fixer can embed ${label} posts right now (${detail}).`,
    `-# ${label} links are left as-is until one recovers. The fixer list is \`${FIXER_ENV_VARS[platform]}\`.`,
  ].join('\n');
}

export function recoveryAlertText(platform: Platform, detail: string, outageMs: number | undefined): string {
  const label = PLATFORM_LABELS[platform];
  const after = outageMs !== undefined ? ` after ${formatOutageDuration(outageMs)}` : '';
  return `✅ **${label} link fixing works again**${after} (via ${detail}).`;
}

/**
 * Turns platform health changes into report-channel posts: one per state change, rate-limited per
 * platform (see the file comment). Sends for one platform are serialized so two quick changes can't
 * race each other into the channel out of order.
 */
export class FixerAlerter {
  private readonly send: (text: string) => Promise<void>;
  private readonly currentState: (platform: Platform) => PlatformState | 'unknown';
  private readonly minIntervalMs: number;
  private readonly store: AlertStore;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly deferred = new Map<Platform, () => void>();
  private readonly lastDetail = new Map<Platform, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: FixerAlerterOptions) {
    this.send = opts.send;
    this.currentState = opts.currentState;
    this.minIntervalMs = opts.minIntervalMs;
    this.store = opts.store ?? memoryAlertStore();
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  /** The fixerHealth listener. Never throws; resolves once any resulting post is done (for tests). */
  handle(change: PlatformHealthChange): Promise<void> {
    this.lastDetail.set(change.platform, change.detail);
    return this.enqueue(() => this.evaluate(change.platform));
  }

  /** Cancels every deferred re-check (shutdown, tests). */
  stop(): void {
    for (const cancel of this.deferred.values()) cancel();
    this.deferred.clear();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((error: unknown) => {
      logger.warn('linkfix: fixer alert failed:', error);
    });
    this.queue = run;
    return run;
  }

  private cancelDeferred(platform: Platform): void {
    this.deferred.get(platform)?.();
    this.deferred.delete(platform);
  }

  private async evaluate(platform: Platform): Promise<void> {
    const current = this.currentState(platform);
    if (current === 'unknown') return;
    const announced = this.store.get(platform);
    // Nothing announced yet means the channel assumes link fixing works.
    const channelBelieves = announced?.state ?? 'up';
    if (current === channelBelieves) {
      // e.g. a suppressed outage that ended before its deferred alert was due.
      this.cancelDeferred(platform);
      return;
    }

    const now = this.now();
    const detail = this.lastDetail.get(platform) ?? 'no detail';

    if (current === 'up') {
      this.cancelDeferred(platform);
      await this.send(recoveryAlertText(platform, detail, announced ? now - announced.at : undefined));
      this.store.set(platform, { state: 'up', at: now });
      return;
    }

    const lastAlertAt = announced?.at;
    const wait = lastAlertAt === undefined ? 0 : lastAlertAt + this.minIntervalMs - now;
    if (wait > 0) {
      if (!this.deferred.has(platform)) {
        logger.info(`linkfix: ${platform} down alert deferred ${formatOutageDuration(wait)} (rate limit)`);
        const cancel = this.schedule(() => {
          this.deferred.delete(platform);
          void this.enqueue(() => this.evaluate(platform));
        }, wait);
        this.deferred.set(platform, cancel);
      }
      return;
    }

    this.cancelDeferred(platform);
    await this.send(downAlertText(platform, detail));
    this.store.set(platform, { state: 'down', at: now });
  }
}
