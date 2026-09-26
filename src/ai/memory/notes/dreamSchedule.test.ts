import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DreamOutcome, NightlyDreamResult } from './dreamer';
import {
  DREAM_FIRST_CHECK_DELAY_MS,
  DREAM_NIGHT_KEY,
  DREAM_TICK_MS,
  DreamScheduler,
  type DreamStateStore,
  dueNight,
  formatDreamReport,
  formatUsd,
} from './dreamSchedule';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const NAMES: Record<string, string> = { [REMI]: 'Remi', [DALE]: 'Dale', [NOVA]: 'Nova' };
const nameOf = (id: string) => NAMES[id];

const person = (ownerId: string) => ({ scope: 'person', ownerId }) as const;
const updated = (ownerId: string, changeSummary: string, costUsd?: number): DreamOutcome => ({
  status: 'updated',
  owner: person(ownerId),
  written: [],
  removed: [],
  changeSummary,
  watermark: 10,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

function memoryState(initial: Record<string, string> = {}): DreamStateStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return { values, get: (key) => values.get(key), set: (key, value) => void values.set(key, value) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('dueNight', () => {
  it('is due from the configured Eastern hour, once per Eastern day', () => {
    // 2026-09-26: EDT (UTC-4).
    expect(dueNight(new Date('2026-09-26T07:59:00Z'), 4, undefined)).toBeUndefined();
    expect(dueNight(new Date('2026-09-26T08:00:00Z'), 4, undefined)).toBe('2026-09-26');
    expect(dueNight(new Date('2026-09-27T01:00:00Z'), 4, '2026-09-25')).toBe('2026-09-26'); // 21:00 ET, caught up
    expect(dueNight(new Date('2026-09-26T08:00:00Z'), 4, '2026-09-26')).toBeUndefined();
    expect(dueNight(new Date('2026-09-26T08:00:00Z'), 4, '2026-09-27')).toBeUndefined();
    // Winter: EST (UTC-5).
    expect(dueNight(new Date('2026-12-15T08:59:00Z'), 4, undefined)).toBeUndefined();
    expect(dueNight(new Date('2026-12-15T09:00:00Z'), 4, undefined)).toBe('2026-12-15');
    expect(dueNight(new Date('2026-12-15T05:30:00Z'), 0, '2026-12-14')).toBe('2026-12-15');
  });
});

describe('formatDreamReport', () => {
  it('names who changed and what, the group, the unchanged and failed, and the cost', () => {
    const result: NightlyDreamResult = {
      day: '2026-09-26',
      people: [
        updated(REMI, 'new job at the bakery'),
        updated(DALE, 'quit Valorant'),
        { status: 'unchanged', owner: person(NOVA), watermark: 3 },
        { status: 'failed', owner: person('100000000000000009'), error: '500', cause: 'error' },
      ],
      group: { status: 'updated', owner: { scope: 'group' }, written: [], removed: [], changeSummary: 'new lore', watermark: 4 },
      costUsd: 0.1834,
    };
    expect(formatDreamReport(result, nameOf)).toBe(
      '🌙 dream · updated 2 profiles (Remi: new job at the bakery; Dale: quit Valorant) · group: new lore · 1 unchanged · 1 failed (someone; retried tomorrow) · $0.18',
    );
  });

  it('posts nothing after a night without changes or failures', () => {
    const quiet: NightlyDreamResult = {
      day: '2026-09-26',
      people: [{ status: 'unchanged', owner: person(REMI), watermark: 3 }],
      group: { status: 'skipped', owner: { scope: 'group' }, reason: 'nothing-new' },
    };
    expect(formatDreamReport(quiet, nameOf)).toBeUndefined();
    expect(formatDreamReport({ day: '2026-09-26', people: [] }, nameOf)).toBeUndefined();
  });

  it('reports a night that only failed, and caps the names', () => {
    const failed: NightlyDreamResult = {
      day: '2026-09-26',
      people: [],
      group: { status: 'failed', owner: { scope: 'group' }, error: 'refused', cause: 'answer' },
    };
    expect(formatDreamReport(failed, nameOf)).toBe('🌙 dream · 1 failed (the group; retried tomorrow)');

    const many: NightlyDreamResult = {
      day: '2026-09-26',
      people: Array.from({ length: 10 }, (_, i) => updated(`10000000000000010${i}`, `change ${i}`)),
    };
    const line = formatDreamReport(many, nameOf) ?? '';
    expect(line).toContain('updated 10 profiles (someone: change 0;');
    expect(line).toContain('someone: change 7; +2 more)');
    expect(line).not.toContain('change 8');
  });

  it('clips long change summaries and formats small costs', () => {
    const line = formatDreamReport({ day: 'd', people: [updated(REMI, 'x'.repeat(200))], costUsd: 0.002 }, nameOf);
    expect(line).toContain(`Remi: ${'x'.repeat(79)}…)`);
    expect(line).toMatch(/· <\$0\.01$/);
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('DreamScheduler.check', () => {
  let clock: Date;
  let state: ReturnType<typeof memoryState>;
  let runs: number;
  let reports: string[];
  let result: NightlyDreamResult;

  function scheduler(extra: Partial<ConstructorParameters<typeof DreamScheduler>[0]> = {}) {
    return new DreamScheduler({
      now: () => clock,
      state,
      nameOf,
      run: async () => {
        runs++;
        return result;
      },
      report: async (text) => {
        reports.push(text);
        return true;
      },
      ...extra,
    });
  }

  beforeEach(() => {
    clock = new Date('2026-09-26T08:30:00Z'); // 04:30 ET
    state = memoryState();
    runs = 0;
    reports = [];
    result = { day: '2026-09-26', people: [updated(REMI, 'new job')], costUsd: 0.05 };
  });

  it('runs the night once per Eastern day, from the dream hour, and reports it', async () => {
    const s = scheduler();
    clock = new Date('2026-09-26T07:30:00Z'); // 03:30 ET
    expect(await s.check()).toBeUndefined();
    clock = new Date('2026-09-26T08:30:00Z');
    expect(await s.check()).toBe(result);
    expect(await s.check()).toBeUndefined();
    clock = new Date('2026-09-26T23:00:00Z');
    expect(await s.check()).toBeUndefined();
    expect(runs).toBe(1);
    expect(state.values.get(DREAM_NIGHT_KEY)).toBe('2026-09-26');
    expect(reports).toEqual(['🌙 dream · updated 1 profile (Remi: new job) · $0.05']);

    clock = new Date('2026-09-27T08:01:00Z');
    await s.check();
    expect(runs).toBe(2);
  });

  it('honours the configured hour', async () => {
    vi.stubEnv('MEMORY_DREAM_HOUR', '6');
    const s = scheduler();
    expect(await s.check()).toBeUndefined();
    clock = new Date('2026-09-26T10:00:00Z');
    expect(await s.check()).toBe(result);
  });

  it('claims the day before running: a night that throws is not retried the same day', async () => {
    const s = scheduler({
      run: async () => {
        runs++;
        throw new Error('database is locked');
      },
    });
    expect(await s.check()).toBeUndefined();
    expect(await s.check()).toBeUndefined();
    expect(runs).toBe(1);
    expect(state.values.get(DREAM_NIGHT_KEY)).toBe('2026-09-26');
  });

  it('never runs two nights at once', async () => {
    let release: () => void = () => undefined;
    const s = scheduler({
      state: memoryState(),
      run: () =>
        new Promise((resolve) => {
          runs++;
          release = () => resolve(result);
        }),
    });
    const first = s.check();
    expect(await s.check()).toBeUndefined();
    release();
    expect(await first).toBe(result);
    expect(runs).toBe(1);
  });

  it('is off with MEMORY_DREAM_ENABLED=false', async () => {
    vi.stubEnv('MEMORY_DREAM_ENABLED', 'false');
    expect(await scheduler().check()).toBeUndefined();
    expect(runs).toBe(0);
    expect(state.values.size).toBe(0);
  });

  it('posts no report line with MEMORY_DREAM_REPORT=false, after a quiet night, or without a report channel', async () => {
    vi.stubEnv('MEMORY_DREAM_REPORT', 'false');
    await scheduler().check();
    expect(reports).toEqual([]);

    vi.stubEnv('MEMORY_DREAM_REPORT', 'true');
    state = memoryState();
    result = { day: '2026-09-26', people: [] };
    await scheduler().check();
    expect(reports).toEqual([]);

    state = memoryState();
    result = { day: '2026-09-26', people: [updated(REMI, 'x')] };
    expect(await scheduler({ report: undefined }).check()).toBe(result);
  });

  it("trims the notes' version history after each night, and survives a failed trim", async () => {
    let prunes = 0;
    const s = scheduler({
      prune: () => {
        prunes++;
        if (prunes > 1) throw new Error('database is locked');
        return 12;
      },
    });
    expect(await s.check()).toBe(result);
    expect(prunes).toBe(1);
    expect(await s.check()).toBeUndefined(); // same day: no night, no trim
    expect(prunes).toBe(1);
    clock = new Date('2026-09-27T08:30:00Z');
    expect(await s.check()).toBe(result);
    expect(prunes).toBe(2);
  });

  it('survives a report that did not go out', async () => {
    const s = scheduler({ report: async () => false });
    expect(await s.check()).toBe(result);
  });
});

describe('DreamScheduler.start', () => {
  it('checks after the startup delay, then every tick, until stopped', async () => {
    vi.useFakeTimers();
    const s = new DreamScheduler({ state: memoryState(), run: async () => ({ day: 'd', people: [] }) });
    const check = vi.spyOn(s, 'check').mockResolvedValue(undefined);
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DREAM_FIRST_CHECK_DELAY_MS - DREAM_TICK_MS);
    // The first delayed check plus one per tick so far.
    expect(check).toHaveBeenCalledTimes(DREAM_FIRST_CHECK_DELAY_MS / DREAM_TICK_MS + 1);
    s.stop();
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS * 3);
    expect(check).toHaveBeenCalledTimes(calls);
  });
});
