// Birthdays: record and list members' birthdays (announced by the birthday scheduler).
import { logger } from '../../logger';
import {
  type Birthday,
  deleteBirthday,
  formatBirthday,
  getBirthday,
  isBirthdayOn,
  listBirthdays,
  nextOccurrence,
  parseBirthdayDate,
  saveBirthday,
} from '../../scheduling/birthdayStore';
import { buildDirectory, currentName, resolvePerson } from '../../scheduling/people';
import { easternDate } from '../../scheduling/time';
import type { ToolDefinition, ToolHandlerContext } from '../types';

function personArg(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function sameDate(a: Pick<Birthday, 'month' | 'day'>, b: Pick<Birthday, 'month' | 'day'>): boolean {
  return a.month === b.month && a.day === b.day;
}

const setBirthdayTool: ToolDefinition = {
  name: 'set_birthday',
  description:
    "Save someone's birthday so the bot wishes them happy birthday in the main channel on the day. Use it when someone tells you their (or someone else's) birthday, or corrects one. The year is optional — only pass it when it was actually said.",
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'Whose birthday: a display name, nickname, IRL name or @mention; "me" for the person talking.',
      },
      date: { type: 'string', description: '"MM-DD" (e.g. "09-25"), or "YYYY-MM-DD" when the birth year is known.' },
    },
    required: ['person', 'date'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const now = new Date();
    const today = easternDate(now);
    const directory = buildDirectory(ctx.message);
    const resolved = resolvePerson(personArg(args.person) || 'me', directory);
    if (!resolved.ok) return `Nothing saved. ${resolved.error}`;
    const person = resolved.person;

    const parsed = parseBirthdayDate(typeof args.date === 'string' ? args.date : '', today);
    if (!parsed.ok) return `Nothing saved. ${parsed.error}`;
    const date = parsed.date;

    const previous = getBirthday(person.userId);
    const isToday = isBirthdayOn(date, today);
    // Announcement state: a correction to the same day keeps it (no second announcement this year);
    // a new date starts fresh. A birthday that is today is marked as announced — it came up in
    // conversation, so the reply is the wish and a separate post later would be a duplicate.
    let lastAnnouncedYear: number | null = previous && sameDate(previous, date) ? previous.lastAnnouncedYear : null;
    if (isToday) lastAnnouncedYear = today.year;

    saveBirthday({
      userId: person.userId,
      date,
      setBy: directory.requester.userId,
      now: now.getTime(),
      lastAnnouncedYear,
    });
    logger.info(`birthdays: ${person.userId}'s birthday set by ${directory.requester.userId}.`);

    const age = date.year ? today.year - date.year : undefined;
    const next = nextOccurrence(date, today);
    const when = isToday
      ? `That's today${age ? ` (turning ${age})` : ''}! Wish them in your reply — no separate announcement will be posted this year.`
      : `Next one is in ${next.daysUntil} day(s)${date.year ? ` (turning ${next.year - date.year})` : ''}.`;
    const change =
      previous && !(sameDate(previous, date) && previous.year === date.year)
        ? ` (was ${formatBirthday(previous)})`
        : '';
    return `Saved ${person.name}'s birthday: ${formatBirthday(date)}${change}. ${when}`;
  },
};

const listBirthdaysTool: ToolDefinition = {
  name: 'list_birthdays',
  description: 'List the birthdays the bot knows, soonest first.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  handler: async () => {
    const today = easternDate(new Date());
    const rows = listBirthdays()
      .map((b) => ({ birthday: b, next: nextOccurrence(b, today) }))
      .sort((a, b) => a.next.daysUntil - b.next.daysUntil);
    if (rows.length === 0) return 'No birthdays saved yet.';
    const lines = rows.map(({ birthday, next }) => {
      const name = currentName(birthday.userId, `<@${birthday.userId}>`);
      const when = next.daysUntil === 0 ? 'TODAY' : next.daysUntil === 1 ? 'tomorrow' : `in ${next.daysUntil} days`;
      const turning = birthday.year ? `, turning ${next.year - birthday.year}` : '';
      return `- ${name}: ${formatBirthday({ month: birthday.month, day: birthday.day, year: null })} (${when}${turning})`;
    });
    return `${rows.length} birthday(s), soonest first:\n${lines.join('\n')}`;
  },
};

const forgetBirthdayTool: ToolDefinition = {
  name: 'forget_birthday',
  description: "Delete someone's saved birthday (e.g. it was wrong and they don't want it replaced).",
  parameters: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'Whose birthday: a name or @mention; "me" for the person talking.' },
    },
    required: ['person'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const directory = buildDirectory(ctx.message);
    const resolved = resolvePerson(personArg(args.person) || 'me', directory);
    if (!resolved.ok) return resolved.error;
    const person = resolved.person;
    if (!deleteBirthday(person.userId)) return `I didn't have a birthday saved for ${person.name}.`;
    logger.info(`birthdays: ${person.userId}'s birthday forgotten by ${directory.requester.userId}.`);
    return `Forgot ${person.name}'s birthday.`;
  },
};

export const birthdayTools: ToolDefinition[] = [setBirthdayTool, listBirthdaysTool, forgetBirthdayTool];
