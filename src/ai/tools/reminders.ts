// Reminders (set/list/cancel) and native Discord polls. Reminders are stored in bot.db and posted by
// the scheduler (src/scheduling/scheduler.ts); polls are posted straight into the channel.
import { config } from '../../config';
import { logger } from '../../logger';
import { isVisibleToEveryone, jumpLink } from '../../scheduling/discord';
import { buildPoll, postPoll } from '../../scheduling/polls';
import {
  type Reminder,
  cancelReminder,
  countOpenByRequester,
  insertReminder,
  listPendingInChannel,
} from '../../scheduling/reminderStore';
import { describeEt, parseReminderTime, relativeTo } from '../../scheduling/time';
import { type ResolvedPerson, buildPeopleDirectory, currentName, requesterOf, resolvePeopleRefs } from '../people';
import type { ToolDefinition, ToolHandlerContext } from '../types';

const MINUTE_MS = 60_000;
const MIN_LEAD_MS = MINUTE_MS;
const MAX_AHEAD_MS = 366 * 24 * 60 * MINUTE_MS;
const MAX_TEXT_CHARS = 1000;
const MAX_TARGETS = 10;
const MAX_LISTED = 25;
const DATE_ONLY = /^\d{4}-\d{1,2}-\d{1,2}$/;

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** `for` as a list of references: an array, or one string (comma-separated names allowed). */
function targetRefs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

type DueTime = { ok: true; dueAt: Date } | { ok: false; error: string };

/** Exactly one of `at` (Eastern wall-clock) and `in_minutes`; ≥1 minute ahead, ≤1 year out. */
export function resolveDueTime(at: unknown, inMinutes: unknown, now: Date): DueTime {
  const nowText = `It's currently ${describeEt(now)}.`;
  const hasAt = !isAbsent(at);
  const hasIn = !isAbsent(inMinutes);
  if (hasAt === hasIn) {
    return { ok: false, error: `Pass exactly one of "at" (Eastern clock time) or "in_minutes". ${nowText}` };
  }

  let dueAt: Date;
  if (hasIn) {
    const minutes = typeof inMinutes === 'string' ? Number(inMinutes.trim()) : inMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
      return { ok: false, error: `in_minutes must be a number of minutes; got ${JSON.stringify(inMinutes)}.` };
    }
    if (minutes < 1) return { ok: false, error: 'Reminders must be at least 1 minute out.' };
    // Whole seconds: nobody needs sub-second precision and it keeps the stored due time readable. Rounded
    // up, never down: "in 1 minute" asked at hh:mm:ss.234 must not come out 59.8 s away and fail the minimum.
    dueAt = new Date(Math.ceil((now.getTime() + minutes * MINUTE_MS) / 1000) * 1000);
  } else {
    if (typeof at === 'string' && DATE_ONLY.test(at.trim())) {
      return {
        ok: false,
        error: `Include a clock time, e.g. "${at.trim()} 09:00" — a date alone would ping them at midnight. ${nowText}`,
      };
    }
    const parsed = typeof at === 'string' ? parseReminderTime(at, now) : undefined;
    if (!parsed) {
      return {
        ok: false,
        error: `Couldn't read the time ${JSON.stringify(at)} — use "YYYY-MM-DD HH:MM" in Eastern time (24h). ${nowText}`,
      };
    }
    dueAt = parsed;
  }

  const lead = dueAt.getTime() - now.getTime();
  if (lead < 0) return { ok: false, error: `${describeEt(dueAt)} is in the past. ${nowText}` };
  if (lead < MIN_LEAD_MS) return { ok: false, error: `Reminders must be at least 1 minute out. ${nowText}` };
  if (lead > MAX_AHEAD_MS) return { ok: false, error: `Reminders can be at most a year out. ${nowText}` };
  return { ok: true, dueAt };
}

function describeTargets(reminder: Reminder): string {
  return reminder.targetIds.map((id) => currentName(id, `<@${id}>`)).join(', ');
}

function formatReminderLine(reminder: Reminder, now: Date): string {
  const due = new Date(reminder.dueAt);
  const setBy = currentName(reminder.requesterId, reminder.requesterName);
  return `#${reminder.id} · for ${describeTargets(reminder)} · ${describeEt(due)} (${relativeTo(due, now)}) · "${reminder.text}" (set by ${setBy})`;
}

const setReminderTool: ToolDefinition = {
  name: 'set_reminder',
  description:
    'Set a reminder the bot posts in this channel later, pinging the people it is for. Use it when someone asks to be reminded (or to remind someone else) of something. Give exactly one of "at" (a clock time) or "in_minutes" (relative: "in 20 min" = 20, "in 2 hours" = 120). Relative requests are more reliable as in_minutes. The result states the resolved Eastern time — tell them when it will go off.',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'What to remind them of, written as the reminder itself, e.g. "take the pizza out".',
      },
      at: {
        type: 'string',
        description: 'When, as Eastern wall-clock time "YYYY-MM-DD HH:MM" (24h), e.g. "2026-09-25 18:30".',
      },
      in_minutes: { type: 'number', description: 'When, as minutes from now (at least 1).' },
      for: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Who to remind: display names, nicknames, IRL names or @mentions from the conversation. Omit to remind the person asking ("me" also means them).',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const now = new Date();
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return 'The reminder needs a text: what should they be reminded of?';
    if (text.length > MAX_TEXT_CHARS) {
      return `That reminder text is ${text.length} characters; keep it under ${MAX_TEXT_CHARS}.`;
    }

    const due = resolveDueTime(args.at, args.in_minutes, now);
    if (!due.ok) return due.error;

    const directory = buildPeopleDirectory(ctx.message);
    const requester = directory.requester ?? requesterOf(ctx.message);
    const refs = targetRefs(args.for);
    let targets: ResolvedPerson[] = [requester];
    if (refs.length > 0) {
      const resolved = resolvePeopleRefs(refs, directory);
      if (!resolved.ok) return `No reminder set. ${resolved.error}`;
      targets = resolved.people;
    }
    if (targets.length > MAX_TARGETS) return `A reminder can ping at most ${MAX_TARGETS} people.`;

    const cap = config.reminders.maxPerUser;
    if (countOpenByRequester(requester.userId) >= cap) {
      return `No reminder set: ${requester.displayName} already has ${cap} pending reminders (the limit). Cancel some first.`;
    }

    const id = insertReminder({
      guildId: ctx.message.guildId ?? null,
      channelId: ctx.channelId,
      requesterId: requester.userId,
      requesterName: requester.displayName,
      targetIds: targets.map((t) => t.userId),
      text,
      dueAt: due.dueAt.getTime(),
      sourceUrl: jumpLink(ctx.message),
      sourcePrivate: !isVisibleToEveryone(ctx.message.channel),
      createdAt: now.getTime(),
    });
    logger.info(
      `reminders: #${id} set by ${requester.userId} for ${targets.length} target(s), due ${due.dueAt.toISOString()}.`,
    );
    return `Reminder #${id} set for ${targets.map((t) => t.displayName).join(', ')}: ${describeEt(due.dueAt)} (${relativeTo(due.dueAt, now)}). It will be posted in this channel.`;
  },
};

const listRemindersTool: ToolDefinition = {
  name: 'list_reminders',
  description: 'List the reminders still pending in this channel (id, who, when in Eastern time, text).',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  handler: async (ctx: ToolHandlerContext) => {
    const now = new Date();
    const pending = listPendingInChannel(ctx.channelId);
    if (pending.length === 0) return 'No pending reminders in this channel.';
    const lines = pending.slice(0, MAX_LISTED).map((r) => formatReminderLine(r, now));
    const more = pending.length > MAX_LISTED ? `\n…and ${pending.length - MAX_LISTED} more.` : '';
    return `${pending.length} pending reminder(s) in this channel (now ${describeEt(now)}):\n${lines.join('\n')}${more}`;
  },
};

const cancelReminderTool: ToolDefinition = {
  name: 'cancel_reminder',
  description:
    'Cancel a pending reminder by id (list_reminders shows ids). Only the person who set it or someone it is for can cancel it.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'number', description: 'The reminder id, e.g. 12 for #12.' } },
    required: ['id'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const raw = typeof args.id === 'string' ? Number(args.id.trim().replace(/^#/, '')) : args.id;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 'Invalid reminder id.';

    const actor = requesterOf(ctx.message);
    const result = cancelReminder(raw, actor.userId);
    switch (result.outcome) {
      case 'not_found':
        return `There's no reminder #${raw}.`;
      case 'forbidden':
        return `${actor.displayName} can't cancel reminder #${raw}: only the person who set it (${currentName(result.reminder.requesterId, result.reminder.requesterName)}) or someone it's for can.`;
      case 'not_pending':
        return `Reminder #${raw} isn't pending anymore (${result.reminder.status === 'cancelled' ? 'already cancelled' : 'it already went off'}).`;
      case 'cancelled':
        logger.info(`reminders: #${raw} cancelled by ${actor.userId}.`);
        return `Cancelled reminder #${raw} ("${result.reminder.text}").`;
    }
  },
};

const createPollTool: ToolDefinition = {
  name: 'create_poll',
  description:
    'Post a native Discord poll in this channel. Use it when someone asks for a poll or the group is trying to vote on something. Limits: question up to 300 characters, 1–10 answers of up to 55 characters each, open for 1–768 hours (default 24). The poll is posted as its own message immediately.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The poll question.' },
      answers: { type: 'array', items: { type: 'string' }, description: 'The answer options, in order (1–10).' },
      duration_hours: { type: 'number', description: 'How long the poll stays open, in whole hours. Default 24.' },
      allow_multiselect: { type: 'boolean', description: 'Let people pick more than one answer. Default false.' },
    },
    required: ['question', 'answers'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const built = buildPoll({
      question: args.question,
      answers: args.answers,
      durationHours: args.duration_hours,
      allowMultiselect: args.allow_multiselect,
    });
    if (!built.ok) return `No poll posted: ${built.error}`;
    const channel = ctx.message.channel;
    if (!('send' in channel)) return "Polls can't be posted in this channel.";
    return postPoll(channel as unknown as Parameters<typeof postPoll>[0], built.poll);
  },
};

export const reminderTools: ToolDefinition[] = [setReminderTool, listRemindersTool, cancelReminderTool, createPollTool];
