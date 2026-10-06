import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../logger';
import { MemoryStore } from '../memoryStore';
import type { DreamOutcome, NightlyDreamResult } from './dreamer';
import type { Note } from './notesStore';
import { DREAM_LEASE_KEY, takeDreamLease } from './dreamLease';
import {
  DREAM_FIRST_CHECK_DELAY_MS,
  DREAM_NIGHT_KEY,
  DREAM_TICK_MS,
  DreamScheduler,
  type DreamStateStore,
  dueNight,
  failureReason,
  formatDreamReport,
  formatUsd,
  NIGHTLY_DREAM_HOLDER,
} from './dreamSchedule';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const NAMES: Record<string, string> = { [REMI]: 'Remi', [DALE]: 'Dale', [NOVA]: 'Nova' };
const nameOf = (id: string) => NAMES[id];

const person = (ownerId: string) => ({ scope: 'person', ownerId }) as const;
const updated = (
  ownerId: string,
  changeSummary: string,
  costUsd?: number,
): Extract<DreamOutcome, { status: 'updated' }> => ({
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
  vi.restoreAllMocks();
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
  const note = (topic: string, scope: 'person' | 'circle' = 'person') => ({ topic, scope }) as unknown as Note;

  it('heads the report with the day, the counts and the cost, then a line per owner with what changed', () => {
    const result: NightlyDreamResult = {
      day: '2026-09-26',
      people: [
        { ...updated(REMI, 'new job at the bakery'), written: [note('profile'), note('work'), note('mtg', 'circle')] },
        { ...updated(DALE, ''), removed: [note('games')] },
        { status: 'unchanged', owner: person(NOVA), watermark: 3 },
        {
          status: 'failed',
          owner: person('100000000000000009'),
          error: 'note "profile": the content is 4105 characters, over the 4000 limit',
          cause: 'answer',
          lastDreamAt: '2026-09-20 08:01:00',
        },
      ],
      group: {
        status: 'updated',
        owner: { scope: 'group' },
        written: [note('lore')],
        removed: [],
        changeSummary: 'new lore: the 2026 LAN, where the whole crew stayed up until 6 am on the last night',
        watermark: 4,
      },
      costUsd: 0.1834,
    };
    expect(formatDreamReport(result, nameOf)).toBe(
      [
        '🌙 dream · Sep 26 · 3 updated · 1 unchanged · 1 failed, retried tomorrow · $0.18',
        '• Remi [profile, work, circle:mtg]: new job at the bakery',
        '• Dale [-games]: (no summary)',
        '• the group [lore]: new lore: the 2026 LAN, where the whole crew stayed up until 6 am on the last night',
        '✖ someone: "profile" too long (4,105 of 4,000) · last good dream Sep 20',
      ].join('\n'),
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

  it('reports a night that only failed, and caps the lines', () => {
    const failed: NightlyDreamResult = {
      day: '2026-09-26',
      people: [{ status: 'failed', owner: person(DALE), error: '429 Rate limit exceeded', cause: 'error', lastDreamAt: null }],
      group: { status: 'failed', owner: { scope: 'group' }, error: 'the answer is not a JSON object', cause: 'answer' },
    };
    expect(formatDreamReport(failed, nameOf)).toBe(
      [
        '🌙 dream · Sep 26 · 2 failed, retried tomorrow',
        '✖ Dale: 429 Rate limit exceeded · no notes yet',
        '✖ the group: the answer was not JSON',
      ].join('\n'),
    );

    // Notes from the import, never dreamed since: said so, not "no notes".
    const imported: NightlyDreamResult = {
      day: '2026-10-06',
      people: [
        {
          status: 'failed',
          owner: person(REMI),
          error: 'note "profile": the content is 4105 characters, over the 4000 limit',
          cause: 'answer',
          lastDreamAt: null,
          notesUpdatedAt: '2026-09-27 18:35:00',
        },
      ],
    };
    expect(formatDreamReport(imported, nameOf)).toContain(
      '✖ Remi: "profile" too long (4,105 of 4,000) · notes from Sep 27, no good dream since',
    );

    const many: NightlyDreamResult = {
      day: '2026-09-26',
      people: Array.from({ length: 30 }, (_, i) => updated(`1000000000000001${String(i).padStart(2, '0')}`, `change ${i}`)),
    };
    const lines = (formatDreamReport(many, nameOf) ?? '').split('\n');
    expect(lines[0]).toBe('🌙 dream · Sep 26 · 30 updated');
    expect(lines).toHaveLength(27);
    expect(lines[25]).toBe('• someone: change 24');
    expect(lines[26]).toBe('… and 5 more');
  });

  it('keeps change summaries whole (they are capped at 300 characters already) and formats small costs', () => {
    const summary = `${'a long sentence about what changed '.repeat(5)}end`;
    const report = formatDreamReport({ day: '2026-10-06', people: [updated(REMI, summary)], costUsd: 0.002 }, nameOf);
    expect(report).toContain(`• Remi: ${summary}`);
    expect(report).toMatch(/^🌙 dream · Oct 6 · 1 updated · <\$0\.01\n/);
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('failureReason', () => {
  it('says why a dream failed in a few words', () => {
    expect(failureReason('circle "mtg": the content is 6400 characters, over the 6000 limit; topic "x" appears twice')).toBe(
      'circle "mtg" too long (6,400 of 6,000)',
    );
    expect(failureReason('the answer was cut off at the length limit')).toBe('the answer was cut off');
    expect(failureReason('the notes changed while dreaming (profile): not saved over them')).toBe(
      'the notes changed while it dreamed (an edit came first)',
    );
    expect(failureReason('the profile lost its "## Traits" section: write the whole profile')).toBe(
      'the rewrite dropped profile sections',
    );
    expect(failureReason(`500 ${'x'.repeat(300)}`)).toHaveLength(120);
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
    expect(reports).toEqual(['🌙 dream · Sep 26 · 1 updated · $0.05\n• Remi: new job']);

    clock = new Date('2026-09-27T08:01:00Z');
    await s.check();
    expect(runs).toBe(2);
  });

  it('waits, the day unclaimed, while another process dreams (logged once), then runs holding the lease', async () => {
    const store = new MemoryStore(':memory:');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const bootstrap = takeDreamLease(store, 'the memory bootstrap (CLI)', { now: () => clock });
    if (!bootstrap.ok) throw new Error('lease busy');
    let heldDuringRun: boolean | undefined;
    const s = scheduler({
      lease: () => takeDreamLease(store, NIGHTLY_DREAM_HOLDER, { now: () => clock }),
      run: async () => {
        runs++;
        const other = takeDreamLease(store, 'the memory bootstrap (CLI)', { now: () => clock });
        heldDuringRun = !other.ok;
        if (other.ok) other.lease.release();
        return result;
      },
    });
    expect(await s.check()).toBeUndefined();
    expect(await s.check()).toBeUndefined();
    expect(runs).toBe(0);
    expect(state.values.has(DREAM_NIGHT_KEY)).toBe(false);
    const waits = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('has been running since'));
    expect(waits).toEqual([
      'dream: the memory bootstrap (CLI) has been running since 2026-09-26 04:30 (Eastern); the night of 2026-09-26 waits until it is done.',
    ]);

    bootstrap.lease.release();
    expect(await s.check()).toBe(result);
    expect(runs).toBe(1);
    expect(heldDuringRun).toBe(true);
    expect(state.values.get(DREAM_NIGHT_KEY)).toBe('2026-09-26');
    // Released after the night, even one that throws.
    expect(store.getState(DREAM_LEASE_KEY)).toBe('');
    clock = new Date('2026-09-27T08:30:00Z');
    const failing = scheduler({
      lease: () => takeDreamLease(store, NIGHTLY_DREAM_HOLDER, { now: () => clock }),
      run: async () => {
        throw new Error('database is locked');
      },
    });
    expect(await failing.check()).toBeUndefined();
    expect(store.getState(DREAM_LEASE_KEY)).toBe('');
    store.close();
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
    // Nothing during the startup delay (a bootstrap import and startup maintenance come first).
    await vi.advanceTimersByTimeAsync(DREAM_FIRST_CHECK_DELAY_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS * 2);
    expect(check).toHaveBeenCalledTimes(3);
    s.stop();
    await vi.advanceTimersByTimeAsync(DREAM_TICK_MS * 3);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops before the first check too, and starts again afterwards', async () => {
    vi.useFakeTimers();
    const s = new DreamScheduler({ state: memoryState(), run: async () => ({ day: 'd', people: [] }) });
    const check = vi.spyOn(s, 'check').mockResolvedValue(undefined);
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(DREAM_FIRST_CHECK_DELAY_MS + DREAM_TICK_MS);
    expect(check).not.toHaveBeenCalled();
    s.start();
    await vi.advanceTimersByTimeAsync(DREAM_FIRST_CHECK_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
    s.stop();
  });
});
