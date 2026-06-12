const ET_DATETIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTimestampET(date: Date): string {
  return ET_DATETIME_FORMAT.format(date);
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
