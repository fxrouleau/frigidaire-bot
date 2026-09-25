import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  applySeed,
  claimAnnouncement,
  deleteBirthday,
  formatBirthday,
  getBirthday,
  isBirthdayOn,
  isLeapYear,
  listBirthdays,
  nextOccurrence,
  parseBirthdayDate,
  parseSeed,
  releaseAnnouncement,
  saveBirthday,
} from './birthdayStore';

const TODAY = { year: 2026, month: 9, day: 25 };
const NOW = new Date('2026-09-25T18:00:00Z');
const USER = '300000000000000001';

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('parseBirthdayDate', () => {
  it('accepts MM-DD and YYYY-MM-DD (and / or . separators)', () => {
    expect(parseBirthdayDate('09-25', TODAY)).toEqual({ ok: true, date: { month: 9, day: 25, year: null } });
    expect(parseBirthdayDate('3-7', TODAY)).toEqual({ ok: true, date: { month: 3, day: 7, year: null } });
    expect(parseBirthdayDate('1995-09-25', TODAY)).toEqual({ ok: true, date: { month: 9, day: 25, year: 1995 } });
    expect(parseBirthdayDate('1995/12/01', TODAY)).toEqual({ ok: true, date: { month: 12, day: 1, year: 1995 } });
  });

  it('accepts Feb 29 without a year, and with a leap year only', () => {
    expect(parseBirthdayDate('02-29', TODAY).ok).toBe(true);
    expect(parseBirthdayDate('2000-02-29', TODAY).ok).toBe(true);
    const common = parseBirthdayDate('2001-02-29', TODAY);
    expect(common).toEqual({ ok: false, error: "February doesn't have a day 29 in 2001." });
  });

  it('rejects impossible dates, future dates and silly years with a reason', () => {
    expect(parseBirthdayDate('13-01', TODAY)).toEqual({ ok: false, error: "There's no month 13." });
    expect(parseBirthdayDate('04-31', TODAY)).toEqual({ ok: false, error: "April doesn't have a day 31." });
    expect(parseBirthdayDate('2027-01-01', TODAY).ok).toBe(false);
    expect(parseBirthdayDate('1850-01-01', TODAY).ok).toBe(false);
    const garbage = parseBirthdayDate('next tuesday', TODAY);
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.error).toContain('MM-DD');
  });
});

describe('calendar math', () => {
  it('knows leap years', () => {
    expect([2024, 2000, 2026, 1900].map(isLeapYear)).toEqual([true, true, false, false]);
  });

  it('celebrates Feb 29 on Feb 28 in common years', () => {
    const leapling = { month: 2, day: 29 };
    expect(isBirthdayOn(leapling, { year: 2026, month: 2, day: 28 })).toBe(true);
    expect(isBirthdayOn(leapling, { year: 2028, month: 2, day: 28 })).toBe(false);
    expect(isBirthdayOn(leapling, { year: 2028, month: 2, day: 29 })).toBe(true);
  });

  it('finds the next occurrence, today included', () => {
    expect(nextOccurrence({ month: 9, day: 25 }, TODAY)).toEqual({ year: 2026, month: 9, day: 25, daysUntil: 0 });
    expect(nextOccurrence({ month: 9, day: 30 }, TODAY)).toMatchObject({ year: 2026, daysUntil: 5 });
    expect(nextOccurrence({ month: 9, day: 24 }, TODAY)).toMatchObject({ year: 2027, daysUntil: 364 });
    expect(nextOccurrence({ month: 2, day: 29 }, TODAY)).toEqual({ year: 2027, month: 2, day: 28, daysUntil: 156 });
  });

  it('formats with and without a year', () => {
    expect(formatBirthday({ month: 9, day: 25, year: null })).toBe('September 25');
    expect(formatBirthday({ month: 1, day: 2, year: 1990 })).toBe('January 2, 1990');
  });
});

describe('storage', () => {
  it('saves, replaces, lists and deletes', () => {
    saveBirthday({
      userId: USER,
      date: { month: 9, day: 25, year: 1995 },
      setBy: 'x',
      now: 1,
      lastAnnouncedYear: null,
    });
    saveBirthday({ userId: 'u2', date: { month: 1, day: 2, year: null }, setBy: 'x', now: 1, lastAnnouncedYear: null });
    saveBirthday({ userId: USER, date: { month: 10, day: 1, year: null }, setBy: 'y', now: 2, lastAnnouncedYear: 2025 });

    expect(getBirthday(USER)).toEqual({
      userId: USER,
      month: 10,
      day: 1,
      year: null,
      setBy: 'y',
      updatedAt: 2,
      lastAnnouncedYear: 2025,
    });
    expect(listBirthdays().map((b) => b.userId)).toEqual(['u2', USER]);
    expect(deleteBirthday(USER)).toBe(true);
    expect(deleteBirthday(USER)).toBe(false);
  });

  it('claims a year only once and can release a failed claim', () => {
    saveBirthday({ userId: USER, date: { month: 9, day: 25, year: null }, setBy: 'x', now: 1, lastAnnouncedYear: 2025 });
    expect(claimAnnouncement(USER, 2026)).toBe(true);
    expect(claimAnnouncement(USER, 2026)).toBe(false);
    releaseAnnouncement(USER, 2026, 2025);
    expect(getBirthday(USER)?.lastAnnouncedYear).toBe(2025);
    expect(claimAnnouncement(USER, 2026)).toBe(true);
  });
});

describe('seeding', () => {
  it('parses userId:MM-DD and userId:YYYY-MM-DD entries and reports bad ones', () => {
    const { entries, errors } = parseSeed(
      [`${USER}:09-25`, '300000000000000002 : 1990-01-02', 'bob:01-01', '300000000000000003:02-30'],
      TODAY,
    );
    expect(entries).toEqual([
      { userId: USER, date: { month: 9, day: 25, year: null } },
      { userId: '300000000000000002', date: { month: 1, day: 2, year: 1990 } },
    ]);
    expect(errors).toHaveLength(2);
  });

  it('only fills in users without a birthday, so chat corrections survive every restart', () => {
    saveBirthday({ userId: USER, date: { month: 3, day: 3, year: null }, setBy: 'chat', now: 1, lastAnnouncedYear: null });

    const result = applySeed([`${USER}:09-25`, '300000000000000002:01-02'], NOW, TODAY);

    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(getBirthday(USER)).toMatchObject({ month: 3, day: 3, setBy: 'chat' });
    expect(getBirthday('300000000000000002')).toMatchObject({ month: 1, day: 2, setBy: 'seed', lastAnnouncedYear: null });
    // Applying the same seed again is a no-op.
    expect(applySeed([`${USER}:09-25`, '300000000000000002:01-02'], NOW, TODAY)).toEqual({ added: 0, skipped: 2 });
  });

  it('never re-seeds a birthday that was forgotten, even on a later boot', () => {
    applySeed([`${USER}:09-25`], NOW, TODAY);
    expect(deleteBirthday(USER)).toBe(true);

    // The next restart applies the same BIRTHDAYS_SEED again.
    expect(applySeed([`${USER}:09-25`], NOW, TODAY)).toEqual({ added: 0, skipped: 1 });
    expect(getBirthday(USER)).toBeUndefined();
  });

  it('does not re-seed a chat-set birthday after it is forgotten either', () => {
    saveBirthday({ userId: USER, date: { month: 3, day: 3, year: null }, setBy: 'chat', now: 1, lastAnnouncedYear: null });
    applySeed([`${USER}:09-25`], NOW, TODAY);
    deleteBirthday(USER);

    expect(applySeed([`${USER}:09-25`], NOW, TODAY)).toEqual({ added: 0, skipped: 1 });
    expect(getBirthday(USER)).toBeUndefined();
  });

  it('still seeds a user added to BIRTHDAYS_SEED later', () => {
    applySeed([`${USER}:09-25`], NOW, TODAY);
    expect(applySeed([`${USER}:09-25`, '300000000000000002:01-02'], NOW, TODAY)).toEqual({ added: 1, skipped: 1 });
    expect(getBirthday('300000000000000002')).toMatchObject({ month: 1, day: 2, setBy: 'seed' });
  });

  it('is a no-op without entries', () => {
    expect(applySeed([], NOW, TODAY)).toEqual({ added: 0, skipped: 0 });
  });

  it('warns when an edited entry disagrees with the saved birthday it can no longer change', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      applySeed([`${USER}:09-25`, '300000000000000002:01-02'], NOW, TODAY);
      expect(warn).not.toHaveBeenCalled();

      // The owner corrects one date on a later deploy; the other entry is unchanged.
      expect(applySeed([`${USER}:09-26`, '300000000000000002:01-02'], NOW, TODAY)).toEqual({ added: 0, skipped: 2 });

      expect(getBirthday(USER)).toMatchObject({ month: 9, day: 25, setBy: 'seed' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        `BIRTHDAYS_SEED has ${USER} as September 26 but the saved birthday is September 25`,
      );
      expect(String(warn.mock.calls[0]?.[0])).toContain('set_birthday');
    } finally {
      warn.mockRestore();
    }
  });

  it('names who saved a conflicting chat-set birthday, and stays quiet when only the seed lacks the year', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      saveBirthday({ userId: USER, date: { month: 3, day: 3, year: 1990 }, setBy: 'chat', now: 1, lastAnnouncedYear: null });
      saveBirthday({ userId: '300000000000000002', date: { month: 1, day: 2, year: 1991 }, setBy: 'chat', now: 1, lastAnnouncedYear: null });

      applySeed([`${USER}:1991-03-03`, '300000000000000002:01-02'], NOW, TODAY);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('as March 3, 1991 but the saved birthday is March 3, 1990 (saved by chat)');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn about a seeded birthday that was forgotten since', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      applySeed([`${USER}:09-25`], NOW, TODAY);
      deleteBirthday(USER);
      applySeed([`${USER}:09-26`], NOW, TODAY);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
