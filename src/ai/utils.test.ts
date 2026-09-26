import { describe, expect, it } from 'vitest';
import { easternParts, formatRelativeAge, parseEasternDateTime } from './utils';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// A fixed UTC instant; building both `now` and the timestamps from UTC keeps these assertions
// identical on any host timezone (the function itself forces UTC by appending 'Z').
const NOW = new Date(Date.UTC(2026, 5, 12, 12, 0, 0));

// Renders a Date back into SQLite's 'YYYY-MM-DD HH:MM:SS' UTC shape (no zone suffix).
function sqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function ago(ms: number): string {
  return sqliteUtc(new Date(NOW.getTime() - ms));
}

describe('formatRelativeAge', () => {
  it('returns "today" for anything under 24h', () => {
    expect(formatRelativeAge(ago(0), NOW)).toBe('today');
    expect(formatRelativeAge(ago(23 * HOUR_MS), NOW)).toBe('today');
  });

  it('uses days from 24h up to 14 days', () => {
    expect(formatRelativeAge(ago(DAY_MS), NOW)).toBe('1d ago');
    expect(formatRelativeAge(ago(13 * DAY_MS + 23 * HOUR_MS), NOW)).toBe('13d ago');
  });

  it('uses weeks from 14 days up to 8 weeks', () => {
    expect(formatRelativeAge(ago(14 * DAY_MS), NOW)).toBe('2w ago');
    expect(formatRelativeAge(ago(55 * DAY_MS), NOW)).toBe('7w ago');
  });

  it('uses months from 8 weeks onward', () => {
    expect(formatRelativeAge(ago(56 * DAY_MS), NOW)).toBe('1mo ago');
    expect(formatRelativeAge(ago(90 * DAY_MS), NOW)).toBe('3mo ago');
  });

  it('clamps future timestamps to "today"', () => {
    expect(formatRelativeAge(ago(-DAY_MS), NOW)).toBe('today');
  });

  it('parses the timestamp as UTC, not host-local time', () => {
    // Exactly 60 days before NOW in UTC. Because the function forces UTC ('Z') and NOW is built from
    // Date.UTC, this lands at "2mo ago" on every host timezone — a local-time parse would skew it.
    expect(formatRelativeAge('2026-04-13 12:00:00', NOW)).toBe('2mo ago');
  });

  it('returns "" for missing or garbage input', () => {
    expect(formatRelativeAge('', NOW)).toBe('');
    expect(formatRelativeAge('not a date', NOW)).toBe('');
    expect(formatRelativeAge('2026-13-99 99:99:99', NOW)).toBe('');
  });

  it('defaults `now` to the current time', () => {
    expect(formatRelativeAge(sqliteUtc(new Date(Date.now() - 5_000)))).toBe('today');
  });
});

describe('parseEasternDateTime', () => {
  it('reads a bare wall-clock time as Eastern standard time in winter', () => {
    expect(parseEasternDateTime('2026-01-15 20:00')?.toISOString()).toBe('2026-01-16T01:00:00.000Z');
  });

  it('reads a bare wall-clock time as Eastern daylight time in summer', () => {
    expect(parseEasternDateTime('2026-07-04T21:30')?.toISOString()).toBe('2026-07-05T01:30:00.000Z');
    expect(parseEasternDateTime('2026-07-04T21:30:15')?.toISOString()).toBe('2026-07-05T01:30:15.000Z');
  });

  it('treats a date alone as Eastern midnight', () => {
    expect(parseEasternDateTime('2026-09-25')?.toISOString()).toBe('2026-09-25T04:00:00.000Z');
  });

  it('honors an explicit offset or Z', () => {
    expect(parseEasternDateTime('2026-01-15T20:00:00Z')?.toISOString()).toBe('2026-01-15T20:00:00.000Z');
    expect(parseEasternDateTime('2026-01-15T20:00:00-08:00')?.toISOString()).toBe('2026-01-16T04:00:00.000Z');
  });

  it('handles both sides of the DST switch', () => {
    // 2026-03-08: clocks jump from 02:00 EST to 03:00 EDT.
    expect(parseEasternDateTime('2026-03-08 01:30')?.toISOString()).toBe('2026-03-08T06:30:00.000Z');
    expect(parseEasternDateTime('2026-03-08 12:00')?.toISOString()).toBe('2026-03-08T16:00:00.000Z');
    // 2026-11-01: clocks fall back from 02:00 EDT to 01:00 EST.
    expect(parseEasternDateTime('2026-11-01 12:00')?.toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });

  it('rejects text that is not a date-time', () => {
    expect(parseEasternDateTime('last night')).toBeUndefined();
    expect(parseEasternDateTime('2026-13-45 99:99')).toBeUndefined();
    expect(parseEasternDateTime('')).toBeUndefined();
  });
});

describe('easternParts', () => {
  it('returns Eastern wall-clock fields', () => {
    expect(easternParts(new Date('2026-07-05T01:30:00Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 4,
      hour: 21,
      minute: 30,
      second: 0,
    });
  });
});
