// Members' birthdays (bot.db) and the calendar math around them. A birthday is a month/day with an
// optional birth year; `last_announced_year` is what makes the daily announcement restart-safe (a year
// is claimed before its announcement goes out, so a restart or a second process never repeats it).
import { logger } from '../logger';
import { getBotDb } from '../storage/botDb';
import { MONTH_NAMES } from './time';

export type Birthday = {
  userId: string;
  month: number;
  day: number;
  year: number | null;
  setBy: string;
  updatedAt: number;
  lastAnnouncedYear: number | null;
};

type BirthdayRow = {
  user_id: string;
  month: number;
  day: number;
  year: number | null;
  set_by: string;
  updated_at: number;
  last_announced_year: number | null;
};

export type CalendarDate = { year: number; month: number; day: number };
export type BirthdayDate = { month: number; day: number; year: number | null };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS birthdays (
    user_id             TEXT    PRIMARY KEY,
    month               INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    day                 INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    year                INTEGER,
    set_by              TEXT    NOT NULL,
    updated_at          INTEGER NOT NULL,
    last_announced_year INTEGER
  );
`;

/** The oldest birth year accepted; anything earlier is a typo. */
const MIN_BIRTH_YEAR = 1900;

function db() {
  const botDb = getBotDb();
  botDb.ensureSchema('birthdays', SCHEMA);
  return botDb;
}

function toBirthday(row: BirthdayRow): Birthday {
  return {
    userId: row.user_id,
    month: row.month,
    day: row.day,
    year: row.year,
    setBy: row.set_by,
    updatedAt: row.updated_at,
    lastAnnouncedYear: row.last_announced_year,
  };
}

// ---- Calendar math ----

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The day a birthday is celebrated in `year`: Feb 29 falls back to Feb 28 outside leap years. */
export function observedDate(birthday: Pick<BirthdayDate, 'month' | 'day'>, year: number): CalendarDate {
  if (birthday.month === 2 && birthday.day === 29 && !isLeapYear(year)) return { year, month: 2, day: 28 };
  return { year, month: birthday.month, day: birthday.day };
}

export function isBirthdayOn(birthday: Pick<BirthdayDate, 'month' | 'day'>, date: CalendarDate): boolean {
  const observed = observedDate(birthday, date.year);
  return observed.month === date.month && observed.day === date.day;
}

function dayNumber(date: CalendarDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

/** The next time the birthday is celebrated, today included, and how many days away that is. */
export function nextOccurrence(
  birthday: Pick<BirthdayDate, 'month' | 'day'>,
  today: CalendarDate,
): CalendarDate & { daysUntil: number } {
  let next = observedDate(birthday, today.year);
  if (dayNumber(next) < dayNumber(today)) next = observedDate(birthday, today.year + 1);
  return { ...next, daysUntil: dayNumber(next) - dayNumber(today) };
}

/** 'September 25' or 'September 25, 1990'. */
export function formatBirthday(birthday: BirthdayDate): string {
  const base = `${MONTH_NAMES[birthday.month - 1]} ${birthday.day}`;
  return birthday.year ? `${base}, ${birthday.year}` : base;
}

export type ParsedBirthday = { ok: true; date: BirthdayDate } | { ok: false; error: string };

const WITH_YEAR = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const WITHOUT_YEAR = /^(?:--)?(\d{1,2})[-/.](\d{1,2})$/;

/** Parses 'MM-DD' or 'YYYY-MM-DD' (also '/' or '.' separated); `today` bounds the birth year. */
export function parseBirthdayDate(text: string, today: CalendarDate): ParsedBirthday {
  const trimmed = text.trim();
  const withYear = trimmed.match(WITH_YEAR);
  const withoutYear = withYear ? undefined : trimmed.match(WITHOUT_YEAR);
  if (!withYear && !withoutYear) {
    return { ok: false, error: `Couldn't read "${trimmed}" — use MM-DD (e.g. 09-25) or YYYY-MM-DD (e.g. 1995-09-25).` };
  }

  const year = withYear ? Number(withYear[1]) : null;
  const month = Number(withYear ? withYear[2] : withoutYear?.[1]);
  const day = Number(withYear ? withYear[3] : withoutYear?.[2]);

  if (month < 1 || month > 12) return { ok: false, error: `There's no month ${month}.` };
  // Without a year, Feb 29 is a real birthday (celebrated Feb 28 in common years).
  const maxDay = daysInMonth(year ?? 2000, month);
  if (day < 1 || day > maxDay) {
    return { ok: false, error: `${MONTH_NAMES[month - 1]} doesn't have a day ${day}${year ? ` in ${year}` : ''}.` };
  }
  if (year !== null) {
    if (year < MIN_BIRTH_YEAR) return { ok: false, error: `${year} is not a believable birth year.` };
    if (dayNumber({ year, month, day }) > dayNumber(today)) {
      return { ok: false, error: `${year}-${month}-${day} is in the future.` };
    }
  }
  return { ok: true, date: { month, day, year } };
}

// ---- Storage ----

export function getBirthday(userId: string): Birthday | undefined {
  const row = db().stmt('SELECT * FROM birthdays WHERE user_id = ?').get(userId) as BirthdayRow | undefined;
  return row ? toBirthday(row) : undefined;
}

export function listBirthdays(): Birthday[] {
  return (db().stmt('SELECT * FROM birthdays ORDER BY month, day').all() as BirthdayRow[]).map(toBirthday);
}

/**
 * Saves (or replaces) a birthday. `lastAnnouncedYear` is written as given: the caller decides whether a
 * correction keeps the old announcement state (same date) or resets it (new date).
 */
export function saveBirthday(input: {
  userId: string;
  date: BirthdayDate;
  setBy: string;
  now: number;
  lastAnnouncedYear: number | null;
}): void {
  db()
    .stmt(
      `INSERT INTO birthdays (user_id, month, day, year, set_by, updated_at, last_announced_year)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         month = excluded.month, day = excluded.day, year = excluded.year, set_by = excluded.set_by,
         updated_at = excluded.updated_at, last_announced_year = excluded.last_announced_year`,
    )
    .run(
      input.userId,
      input.date.month,
      input.date.day,
      input.date.year,
      input.setBy,
      input.now,
      input.lastAnnouncedYear,
    );
}

export function deleteBirthday(userId: string): boolean {
  return db().stmt('DELETE FROM birthdays WHERE user_id = ?').run(userId).changes === 1;
}

/**
 * Claims `year`'s announcement for a user. True only for the caller that moved the watermark, so an
 * announcement can never go out twice for the same year.
 */
export function claimAnnouncement(userId: string, year: number): boolean {
  return (
    db()
      .stmt(
        `UPDATE birthdays SET last_announced_year = ?
         WHERE user_id = ? AND (last_announced_year IS NULL OR last_announced_year < ?)`,
      )
      .run(year, userId, year).changes === 1
  );
}

/** Undoes a claim whose announcement could not be posted, so a later tick retries it. */
export function releaseAnnouncement(userId: string, year: number, previous: number | null): void {
  db()
    .stmt('UPDATE birthdays SET last_announced_year = ? WHERE user_id = ? AND last_announced_year = ?')
    .run(previous, userId, year);
}

// ---- Seeding (BIRTHDAYS_SEED) ----

export type SeedEntry = { userId: string; date: BirthdayDate };

const SEED_ENTRY = /^(\d{15,21})\s*:\s*(\S+)$/;

/** Parses `userId:MM-DD` / `userId:YYYY-MM-DD` entries; malformed ones are reported, not fatal. */
export function parseSeed(entries: string[], today: CalendarDate): { entries: SeedEntry[]; errors: string[] } {
  const parsed: SeedEntry[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const match = entry.trim().match(SEED_ENTRY);
    if (!match) {
      errors.push(`"${entry}" is not userId:MM-DD or userId:YYYY-MM-DD`);
      continue;
    }
    const date = parseBirthdayDate(match[2], today);
    if (!date.ok) {
      errors.push(`"${entry}": ${date.error}`);
      continue;
    }
    parsed.push({ userId: match[1], date: date.date });
  }
  return { entries: parsed, errors };
}

/**
 * Applies BIRTHDAYS_SEED: inserts each entry whose user has no birthday yet. Entries for users who
 * already have one (set through the tool, or seeded on an earlier boot) are left alone, so the variable
 * can stay set forever without overwriting corrections made in chat.
 */
export function applySeed(rawEntries: string[], now: Date, today: CalendarDate): { added: number; skipped: number } {
  if (rawEntries.length === 0) return { added: 0, skipped: 0 };
  const { entries, errors } = parseSeed(rawEntries, today);
  for (const error of errors) logger.warn(`birthdays: ignoring BIRTHDAYS_SEED entry ${error}`);

  const store = db();
  let added = 0;
  store.transaction(() => {
    for (const entry of entries) {
      added += store
        .stmt(
          `INSERT INTO birthdays (user_id, month, day, year, set_by, updated_at, last_announced_year)
           VALUES (?, ?, ?, ?, 'seed', ?, NULL)
           ON CONFLICT(user_id) DO NOTHING`,
        )
        .run(entry.userId, entry.date.month, entry.date.day, entry.date.year, now.getTime()).changes;
    }
  });
  return { added, skipped: entries.length - added };
}
