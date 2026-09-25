// Human-facing Eastern-time rendering for the scheduling features. Everyone in the server lives in
// America/New_York, so every time a tool result or a post shows is Eastern wall-clock, stamped "ET".
import { easternParts, easternWallClockToDate, formatTimestampET, parseEasternDateTime } from '../ai/utils';

const ET_TIMEZONE = 'America/New_York';

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: ET_TIMEZONE, weekday: 'short' });
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: ET_TIMEZONE, hour: 'numeric', minute: '2-digit' });

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** 'Fri 2026-09-25 15:00 ET' — unambiguous for the model, readable for people. */
export function describeEt(date: Date): string {
  return `${WEEKDAY_FORMAT.format(date)} ${formatTimestampET(date)} ET`;
}

/** '3:05 PM' in Eastern time. */
export function clockEt(date: Date): string {
  return CLOCK_FORMAT.format(date);
}

/** A terse duration: '45s', '12m', '2h 5m', '3d 4h', '41d'. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(Math.abs(ms) / 60_000);
  if (totalMinutes < 1) return `${Math.round(Math.abs(ms) / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 14 && remHours > 0) return `${days}d ${remHours}h`;
  return `${days}d`;
}

/** 'in 2h 5m' / '12m ago'. */
export function relativeTo(target: Date, now: Date): string {
  const delta = target.getTime() - now.getTime();
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`;
}

const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;

/**
 * Parses the `at` of a reminder: anything parseEasternDateTime accepts ('2026-09-25 15:00', an explicit
 * offset, …) plus a bare 'HH:MM', which means the next time the Eastern clock reads that (today, or
 * tomorrow when it has already passed). Returns undefined for anything unrecognizable.
 */
export function parseReminderTime(text: string, now: Date): Date | undefined {
  const trimmed = text.trim();
  const timeOnly = trimmed.match(TIME_ONLY);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    if (hour > 23 || minute > 59) return undefined;
    const today = easternParts(now);
    const candidate = easternWallClockToDate(today.year, today.month, today.day, hour, minute);
    if (candidate.getTime() > now.getTime()) return candidate;
    // Tomorrow's calendar date via UTC arithmetic (no DST involved in stepping a date), then that
    // date's wall clock converted with DST applied.
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    return easternWallClockToDate(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
    );
  }
  return parseEasternDateTime(trimmed);
}

/** Today's Eastern calendar date. */
export function easternDate(now: Date): { year: number; month: number; day: number } {
  const { year, month, day } = easternParts(now);
  return { year, month, day };
}
