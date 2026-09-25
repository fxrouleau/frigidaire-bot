import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  type AlertStore,
  FixerAlerter,
  botDbAlertStore,
  downAlertText,
  formatOutageDuration,
  memoryAlertStore,
  recoveryAlertText,
} from './fixerAlerts';
import type { PlatformHealthChange, PlatformState } from './fixerHealth';
import type { Platform } from './platforms';

const HOUR = 60 * 60 * 1000;
const INTERVAL = 6 * HOUR;

type Harness = {
  alerter: FixerAlerter;
  sent: string[];
  timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
  setNow: (ms: number) => void;
  /** While true, every post fails the way sendToReportChannel reports it (resolves false). */
  setFailing: (failing: boolean) => void;
  change: (platform: Platform, state: PlatformState, detail?: string) => Promise<void>;
  fireTimers: () => Promise<void>;
};

function harness(store: AlertStore = memoryAlertStore()): Harness {
  let now = 0;
  let failing = false;
  const sent: string[] = [];
  const states = new Map<Platform, PlatformState>();
  const timers: Harness['timers'] = [];
  const alerter = new FixerAlerter({
    send: async (text) => {
      if (failing) return false;
      sent.push(text);
      return true;
    },
    currentState: (platform) => states.get(platform) ?? 'unknown',
    minIntervalMs: INTERVAL,
    store,
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const change = (platform: Platform, state: PlatformState, detail = 'a.test: down') => {
    const previous = states.get(platform) ?? 'unknown';
    states.set(platform, state);
    const event: PlatformHealthChange = { platform, state, previous, at: now, detail };
    return alerter.handle(event);
  };
  const fireTimers = async () => {
    const due = timers.splice(0).filter((timer) => !timer.cancelled);
    for (const timer of due) timer.callback();
    await alerter.idle();
  };
  return {
    alerter,
    sent,
    timers,
    setNow: (ms) => {
      now = ms;
    },
    setFailing: (value) => {
      failing = value;
    },
    change,
    fireTimers,
  };
}

describe('FixerAlerter', () => {
  it('waits out a rate-limit window longer than setTimeout can hold, without spinning', async () => {
    vi.useFakeTimers();
    const DAY = 24 * HOUR;
    const sent: string[] = [];
    const states = new Map<Platform, PlatformState>();
    let evaluations = 0;
    const alerter = new FixerAlerter({
      send: async (text) => {
        sent.push(text);
        return true;
      },
      currentState: (platform) => {
        evaluations += 1;
        return states.get(platform) ?? 'unknown';
      },
      minIntervalMs: 30 * DAY,
    });
    const change = (state: PlatformState) => {
      const previous = states.get('instagram') ?? 'unknown';
      states.set('instagram', state);
      return alerter.handle({ platform: 'instagram', state, previous, at: Date.now(), detail: 'a.test: down' });
    };
    try {
      await change('down');
      await change('up');
      await change('down');
      expect(sent).toHaveLength(2);

      evaluations = 0;
      await vi.advanceTimersByTimeAsync(1000);
      expect(evaluations).toBe(0);

      await vi.advanceTimersByTimeAsync(30 * DAY);
      expect(sent).toHaveLength(3);
      expect(evaluations).toBe(2);
    } finally {
      alerter.stop();
      vi.useRealTimers();
    }
  });

  it('posts once when a platform goes down, and once when it recovers', async () => {
    const h = harness();

    await h.change('instagram', 'down', 'instagram7.com: down, uuinstagram.com: cooling down');
    h.setNow(2 * HOUR + 15 * 60 * 1000);
    await h.change('instagram', 'up', 'uuinstagram.com');

    expect(h.sent).toEqual([
      downAlertText('instagram', 'instagram7.com: down, uuinstagram.com: cooling down'),
      recoveryAlertText('instagram', 'uuinstagram.com', 2 * HOUR + 15 * 60 * 1000),
    ]);
    expect(h.sent[0]).toContain('INSTAGRAM_FIXERS');
    expect(h.sent[1]).toContain('after 2 h 15 min');
  });

  it('says nothing about a platform that was never announced down', async () => {
    const h = harness();

    await h.change('tiktok', 'up', 'tnktok.com');

    expect(h.sent).toEqual([]);
  });

  it('defers a down alert inside the rate-limit window and posts it at the end if still down', async () => {
    const h = harness();
    await h.change('instagram', 'down');
    h.setNow(10 * 60 * 1000);
    await h.change('instagram', 'up', 'b.test');
    h.setNow(30 * 60 * 1000);
    await h.change('instagram', 'down', 'flapping again');

    expect(h.sent).toHaveLength(2); // down + recovery; the second down waits
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(10 * 60 * 1000 + INTERVAL - 30 * 60 * 1000);

    h.setNow(10 * 60 * 1000 + INTERVAL);
    await h.fireTimers();

    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]).toBe(downAlertText('instagram', 'flapping again'));
  });

  it('drops a deferred down alert when the platform recovered before it was due', async () => {
    const h = harness();
    await h.change('instagram', 'down');
    await h.change('instagram', 'up', 'b.test');
    h.setNow(HOUR);
    await h.change('instagram', 'down');
    h.setNow(2 * HOUR);
    await h.change('instagram', 'up', 'b.test');

    expect(h.timers[0].cancelled).toBe(true);
    h.setNow(INTERVAL + 1);
    await h.fireTimers();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps one deferred check per platform however often it flaps', async () => {
    const h = harness();
    await h.change('twitter', 'down');
    await h.change('twitter', 'up', 'x');
    for (let i = 1; i <= 5; i++) {
      h.setNow(i * 60 * 1000);
      await h.change('twitter', 'down');
      await h.change('twitter', 'up', 'x');
    }
    await h.change('twitter', 'down');

    expect(h.sent).toHaveLength(2);
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
  });

  it('rate-limits per platform, not globally', async () => {
    const h = harness();
    await h.change('instagram', 'down');
    await h.change('reddit', 'down');

    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toContain('Reddit');
  });

  it('survives a restart mid-outage: no repeated down alert, and the recovery still gets announced', async () => {
    const store = memoryAlertStore();
    const before = harness(store);
    await before.change('bluesky', 'down');

    const after = harness(store); // fresh process, same persisted state
    after.setNow(HOUR);
    await after.change('bluesky', 'down');
    expect(after.sent).toEqual([]);
    after.setNow(3 * HOUR);
    await after.change('bluesky', 'up', 'fxbsky.app');
    expect(after.sent).toEqual([recoveryAlertText('bluesky', 'fxbsky.app', 3 * HOUR)]);
  });

  it('records nothing for a down alert that did not post, and re-sends it on the re-check', async () => {
    const store = memoryAlertStore();
    const h = harness(store);
    h.setFailing(true);
    await h.change('instagram', 'down', 'every fixer 5xx');

    expect(h.sent).toEqual([]);
    expect(store.get('instagram')).toBeUndefined(); // the channel was never told
    expect(h.timers).toHaveLength(1);

    h.setFailing(false);
    h.setNow(10 * 60 * 1000);
    await h.fireTimers();

    expect(h.sent).toEqual([downAlertText('instagram', 'every fixer 5xx')]);
    expect(store.get('instagram')).toEqual({ state: 'down', at: 10 * 60 * 1000 });
  });

  it('retries a recovery alert that did not post, and drops a failed down alert once the platform is back', async () => {
    const h = harness();
    await h.change('tiktok', 'down');
    h.setFailing(true);
    h.setNow(HOUR);
    await h.change('tiktok', 'up', 'tnktok.com');
    expect(h.sent).toHaveLength(1);

    h.setFailing(false);
    await h.fireTimers();
    expect(h.sent).toEqual([downAlertText('tiktok', 'a.test: down'), recoveryAlertText('tiktok', 'tnktok.com', HOUR)]);

    // A down alert that failed, then a recovery before the re-check: nothing to say either way.
    h.setFailing(true);
    h.setNow(INTERVAL + HOUR);
    await h.change('reddit', 'down');
    h.setFailing(false);
    await h.change('reddit', 'up', 'vxreddit.com');
    await h.fireTimers();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps going when a send fails', async () => {
    const sent: string[] = [];
    let fail = true;
    const states = new Map<Platform, PlatformState>();
    const alerter = new FixerAlerter({
      send: async (text) => {
        if (fail) throw new Error('Discord is down');
        sent.push(text);
        return true;
      },
      currentState: (platform) => states.get(platform) ?? 'unknown',
      minIntervalMs: INTERVAL,
      now: () => 0,
      schedule: () => () => {},
    });
    states.set('tiktok', 'down');
    await expect(
      alerter.handle({ platform: 'tiktok', state: 'down', previous: 'unknown', at: 0, detail: 'x' }),
    ).resolves.toBeUndefined();

    fail = false;
    states.set('instagram', 'down');
    await alerter.handle({ platform: 'instagram', state: 'down', previous: 'unknown', at: 0, detail: 'y' });
    expect(sent).toHaveLength(1);
  });
});

describe('botDbAlertStore', () => {
  beforeEach(() => {
    setBotDbForTesting(new BotDb(':memory:'));
  });

  afterEach(() => {
    setBotDbForTesting(undefined);
  });

  it('persists what was announced per platform', () => {
    botDbAlertStore().set('instagram', { state: 'down', at: 123 });
    botDbAlertStore().set('instagram', { state: 'up', at: 456 });
    botDbAlertStore().set('reddit', { state: 'down', at: 789 });

    const fresh = botDbAlertStore();
    expect(fresh.get('instagram')).toEqual({ state: 'up', at: 456 });
    expect(fresh.get('reddit')).toEqual({ state: 'down', at: 789 });
    expect(fresh.get('twitter')).toBeUndefined();
  });

  it('falls back to memory when the database is unusable', () => {
    const broken = new BotDb(':memory:');
    broken.close();
    setBotDbForTesting(broken);
    const store = botDbAlertStore();

    store.set('tiktok', { state: 'down', at: 1 });

    expect(store.get('tiktok')).toEqual({ state: 'down', at: 1 });
  });
});

describe('formatOutageDuration', () => {
  it.each([
    [30 * 1000, '1 min'],
    [45 * 60 * 1000, '45 min'],
    [HOUR, '1 h'],
    [3 * HOUR + 5 * 60 * 1000, '3 h 5 min'],
    [48 * HOUR, '2 d'],
    [52 * HOUR, '2 d 4 h'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatOutageDuration(ms)).toBe(text);
  });
});
