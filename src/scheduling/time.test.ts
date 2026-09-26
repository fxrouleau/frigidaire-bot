import { describe, expect, it } from 'vitest';
import { clockEt, describeEt, easternDate, formatDuration, parseReminderTime, relativeTo } from './time';

describe('describeEt / clockEt', () => {
  it('renders Eastern wall-clock with the weekday, in both DST regimes', () => {
    expect(describeEt(new Date('2026-09-25T19:00:00Z'))).toBe('Fri 2026-09-25 15:00 ET');
    expect(describeEt(new Date('2026-01-16T01:00:00Z'))).toBe('Thu 2026-01-15 20:00 ET');
    expect(clockEt(new Date('2026-09-25T19:05:00Z'))).toBe('3:05 PM');
  });
});

describe('formatDuration / relativeTo', () => {
  it('picks a terse unit for the size of the gap', () => {
    expect(formatDuration(20_000)).toBe('20s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(125 * 60_000)).toBe('2h 5m');
    expect(formatDuration(3 * 3_600_000)).toBe('3h');
    expect(formatDuration((3 * 24 + 4) * 3_600_000)).toBe('3d 4h');
    expect(formatDuration(41 * 24 * 3_600_000)).toBe('41d');
  });

  it('says "in" for the future and "ago" for the past', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    expect(relativeTo(new Date('2026-09-25T12:30:00Z'), now)).toBe('in 30m');
    expect(relativeTo(new Date('2026-09-25T11:30:00Z'), now)).toBe('30m ago');
  });
});

describe('parseReminderTime', () => {
  const now = new Date('2026-09-25T18:00:00Z'); // 14:00 EDT

  it('reads a full Eastern date-time like parseEasternDateTime', () => {
    expect(parseReminderTime('2026-09-25 18:30', now)?.toISOString()).toBe('2026-09-25T22:30:00.000Z');
    expect(parseReminderTime('2026-12-25T09:00', now)?.toISOString()).toBe('2026-12-25T14:00:00.000Z');
  });

  it('reads a bare HH:MM as the next time the Eastern clock shows it', () => {
    expect(parseReminderTime('15:30', now)?.toISOString()).toBe('2026-09-25T19:30:00.000Z');
    // 09:00 already passed today → tomorrow morning.
    expect(parseReminderTime('9:00', now)?.toISOString()).toBe('2026-09-26T13:00:00.000Z');
  });

  it('crosses a DST switch correctly for tomorrow', () => {
    // Saturday 2026-10-31 20:00 EDT; 08:00 tomorrow is after the switch back to EST.
    const beforeSwitch = new Date('2026-11-01T00:00:00Z');
    expect(parseReminderTime('08:00', beforeSwitch)?.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('rejects garbage and impossible clock times', () => {
    expect(parseReminderTime('tomorrow at noon', now)).toBeUndefined();
    expect(parseReminderTime('25:00', now)).toBeUndefined();
    expect(parseReminderTime('2026-02-30 10:00', now)).toBeUndefined();
  });
});

describe('easternDate', () => {
  it('is the Eastern calendar date, not the UTC one', () => {
    expect(easternDate(new Date('2026-09-26T02:00:00Z'))).toEqual({ year: 2026, month: 9, day: 25 });
  });
});
