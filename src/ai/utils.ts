const ET_TIMEZONE = 'America/New_York';

const ET_DATETIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ET_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const ET_DATETIME_WITH_ZONE_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ET_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** 'YYYY-MM-DD HH:MM' in Eastern time — the message timestamp format used in every prompt. */
export function formatTimestampET(date: Date): string {
  return ET_DATETIME_FORMAT.format(date);
}

/** 'YYYY-MM-DDTHH:MM:SS EST|EDT' — the "current time" line of the chat system prompt. */
export function formatCurrentTimeET(now: Date = new Date()): string {
  return ET_DATETIME_WITH_ZONE_FORMAT.format(now).replace(' ', 'T');
}

const ET_PARTS_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Eastern wall-clock fields of an instant. */
export function easternParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const fields: Record<string, number> = {};
  for (const part of ET_PARTS_FORMAT.formatToParts(date)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

/** Eastern UTC offset in minutes at `date` (-300 for EST, -240 for EDT). */
function easternOffsetMinutes(date: Date): number {
  const p = easternParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** The instant at which Eastern wall-clock time reads the given fields (DST handled). */
export function easternWallClockToDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes: the offset at the first guess can differ from the offset at the answer when the guess
  // lands on the other side of a DST switch.
  const first = naiveUtc - easternOffsetMinutes(new Date(naiveUtc)) * 60_000;
  return new Date(naiveUtc - easternOffsetMinutes(new Date(first)) * 60_000);
}

const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Parses a date-time a model or a person wrote. The server runs on Eastern time, so a bare wall-clock
 * value ('2026-09-25 20:00', '2026-09-25T20:00', '2026-09-25') means Eastern time, DST included. An
 * explicit offset or trailing Z is honored as written. Returns undefined for anything unrecognizable.
 */
export function parseEasternDateTime(text: string): Date | undefined {
  const trimmed = text.trim();
  const naive = trimmed.match(NAIVE_DATE_TIME);
  if (naive) {
    const [year, month, day, hour, minute, second] = naive.slice(1).map((v) => Number(v ?? 0));
    // Date.UTC silently rolls month 13 into next year; reject out-of-range fields instead.
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
      return undefined;
    }
    return easternWallClockToDate(year, month, day, hour, minute, second);
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const DAY_MS = 86_400_000;

/**
 * Renders a SQLite `datetime('now')` timestamp ('YYYY-MM-DD HH:MM:SS', UTC, no zone) as a terse
 * relative age for prompt injection. The space→'T' + 'Z' rewrite makes the UTC explicit; without it
 * `new Date()` reads the string as local time and skews on any non-UTC host. Garbage/missing input
 * yields '' so prompt building never throws.
 */
export function formatRelativeAge(sqliteUtcTimestamp: string, now: Date = new Date()): string {
  if (!sqliteUtcTimestamp) return '';

  const parsed = new Date(`${sqliteUtcTimestamp.replace(' ', 'T')}Z`);
  const elapsedMs = now.getTime() - parsed.getTime();
  if (!Number.isFinite(elapsedMs)) return '';

  const days = Math.max(0, elapsedMs) / DAY_MS;
  if (days < 1) return 'today';
  if (days < 14) return `${Math.floor(days)}d ago`;
  if (days < 56) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
