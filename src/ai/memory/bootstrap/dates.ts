// Eastern-time date labels for the memory bootstrap's transcripts and manifests (everyone lives in
// America/New_York; see src/ai/utils.ts).
import { easternParts } from '../../utils';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number) => String(n).padStart(2, '0');

/** The Eastern date of an instant, YYYY-MM-DD. */
export function easternDay(ms: number): string {
  const p = easternParts(new Date(ms));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The Eastern month of an instant, YYYY-MM. */
export function easternMonth(ms: number): string {
  return easternDay(ms).slice(0, 7);
}

/** The Eastern wall-clock time of an instant, HH:MM. */
export function easternTime(ms: number): string {
  const p = easternParts(new Date(ms));
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'YYYY-MM-DD HH:MM' in Eastern time. */
export function easternStamp(ms: number): string {
  return `${easternDay(ms)} ${easternTime(ms)}`;
}

/** 'YYYY-MM-DD (Weekday)'. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${day} (${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
