import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReminder, insertReminder, listPendingInChannel } from '../../scheduling/reminderStore';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { toolDefinitions } from '../tools';
import { type ToolDefinition, type ToolHandlerContext, createTurnEffects } from '../types';
import { reminderTools, resolveDueTime } from './reminders';

const REMI = '600000000000000001';
const JASPER = '600000000000000002';
const STRANGER = '600000000000000003';
// Friday 2026-09-25 14:00 EDT
const NOW = new Date('2026-09-25T18:00:00Z');

function tool(name: string): ToolDefinition {
  const found = reminderTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function ctxFor(opts: Parameters<typeof createFakeMessage>[0] = {}) {
  const fake = createFakeMessage({
    authorId: REMI,
    authorDisplayName: 'fridge enjoyer',
    channelId: 'channel-1',
    messageId: 'msg-42',
    ...opts,
  });
  Object.assign(fake.message, { guildId: 'guild-1' });
  const ctx = {
    message: fake.message,
    channelId: fake.message.channel.id,
    turn: createTurnEffects(),
  } as unknown as ToolHandlerContext;
  return { ctx, fake };
}

function run(name: string, args: Record<string, unknown>, opts: Parameters<typeof createFakeMessage>[0] = {}) {
  return tool(name).handler(ctxFor(opts).ctx, args);
}

let memory: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  memory.upsertIdentity(REMI, 'fridge enjoyer');
  memory.upsertIdentity(JASPER, 'Wheelie');
  memory.updateIdentityMeta(JASPER, { irl_name: 'Jasper' });
  vi.stubEnv('REMINDERS_MAX_PER_USER', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('tool registration', () => {
  it('offers set/list/cancel reminder and create_poll to the chat model', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['set_reminder', 'list_reminders', 'cancel_reminder', 'create_poll']));
  });
});

describe('resolveDueTime', () => {
  it('needs exactly one of at / in_minutes', () => {
    const both = resolveDueTime('2026-09-25 15:00', 5, NOW);
    const neither = resolveDueTime(undefined, null, NOW);
    for (const result of [both, neither]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('exactly one');
    }
    expect(resolveDueTime('', 5, NOW).ok).toBe(true);
  });

  it('enforces at least a minute ahead and at most a year out', () => {
    const fail = (at: unknown, inMinutes: unknown) => {
      const result = resolveDueTime(at, inMinutes, NOW);
      return result.ok ? '' : result.error;
    };
    expect(fail(undefined, 0.5)).toBe('Reminders must be at least 1 minute out.');
    expect(fail('2026-09-25 13:00', undefined)).toContain('is in the past. It\'s currently Fri 2026-09-25 14:00 ET.');
    expect(fail(`${NOW.toISOString().slice(0, 16)}:30Z`, undefined)).toContain('at least 1 minute out');
    expect(fail(undefined, 367 * 24 * 60)).toContain('at most a year out');
    expect(fail('2027-09-25 14:00', undefined)).toBe('');
    expect(fail(undefined, 'soon')).toContain('must be a number');
    expect(fail('tomorrow', undefined)).toContain('YYYY-MM-DD HH:MM');
  });

  it('asks for a clock time instead of silently pinging at midnight', () => {
    const result = resolveDueTime('2026-09-26', undefined, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Include a clock time, e.g. "2026-09-26 09:00"');
  });

  it('reads in_minutes relative to now and at as Eastern wall-clock', () => {
    const relative = resolveDueTime(undefined, '90', NOW);
    expect(relative.ok && relative.dueAt.toISOString()).toBe('2026-09-25T19:30:00.000Z');
    const absolute = resolveDueTime('2026-09-25 18:30', undefined, NOW);
    expect(absolute.ok && absolute.dueAt.toISOString()).toBe('2026-09-25T22:30:00.000Z');
  });
});

describe('set_reminder', () => {
  it('stores guild, channel, requester, targets, text, due time and the jump link', async () => {
    const result = await run('set_reminder', { text: 'take the pizza out', in_minutes: 20 });

    expect(result).toBe(
      'Reminder #1 set for fridge enjoyer: Fri 2026-09-25 14:20 ET (in 20m). It will be posted in this channel.',
    );
    expect(getReminder(1)).toMatchObject({
      guildId: 'guild-1',
      channelId: 'channel-1',
      requesterId: REMI,
      requesterName: 'fridge enjoyer',
      targetIds: [REMI],
      text: 'take the pizza out',
      dueAt: Date.parse('2026-09-25T18:20:00Z'),
      sourceUrl: 'https://discord.com/channels/guild-1/channel-1/msg-42',
      status: 'pending',
    });
  });

  it('reminds other people by name, IRL name or mention', async () => {
    const result = await run(
      'set_reminder',
      { text: 'ranked tonight', at: '2026-09-25 21:00', for: ['Jasper', 'me', '<@600000000000000009>'] },
      { mentionedUsers: [{ id: '600000000000000009', displayName: 'Newbie' }] },
    );
    expect(result).toContain('set for Wheelie, fridge enjoyer, Newbie: Fri 2026-09-25 21:00 ET (in 7h)');
    expect(getReminder(1)?.targetIds).toEqual([JASPER, REMI, '600000000000000009']);
  });

  it('accepts a comma-separated string for "for"', async () => {
    await run('set_reminder', { text: 'x', in_minutes: 5, for: 'Wheelie, me' });
    expect(getReminder(1)?.targetIds).toEqual([JASPER, REMI]);
  });

  it('creates nothing when someone cannot be resolved', async () => {
    const result = await run('set_reminder', { text: 'x', in_minutes: 5, for: ['Gandalf'] });
    expect(result).toMatch(/^No reminder set\. I don't know who "Gandalf" is\./);
    expect(getReminder(1)).toBeUndefined();
  });

  it('rejects an empty or huge text and bad times without storing anything', async () => {
    expect(await run('set_reminder', { text: '  ', in_minutes: 5 })).toContain('needs a text');
    expect(await run('set_reminder', { text: 'x'.repeat(1001), in_minutes: 5 })).toContain('under 1000');
    expect(await run('set_reminder', { text: 'x', in_minutes: 5, at: '2026-09-25 15:00' })).toContain('exactly one');
    expect(getReminder(1)).toBeUndefined();
  });

  it('caps pending reminders per requester', async () => {
    vi.stubEnv('REMINDERS_MAX_PER_USER', '2');
    await run('set_reminder', { text: 'one', in_minutes: 5 });
    await run('set_reminder', { text: 'two', in_minutes: 5 });
    const third = await run('set_reminder', { text: 'three', in_minutes: 5 });
    expect(third).toBe('No reminder set: fridge enjoyer already has 2 pending reminders (the limit). Cancel some first.');
    // Someone else still can.
    expect(await run('set_reminder', { text: 'mine', in_minutes: 5 }, { authorId: JASPER })).toContain('Reminder #3');
  });
});

describe('set_reminder / cancel_reminder with a linked side account (LINKED_ACCOUNTS)', () => {
  const SIDE = '600000000000000004';

  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${JASPER}`);
    memory.upsertIdentity(SIDE, 'JayAlt', 'jay_alt');
  });

  it("targets the main account when the side account's name or mention is used, and for \"me\" from it", async () => {
    await run('set_reminder', { text: 'ranked', in_minutes: 5, for: ['JayAlt', `<@${SIDE}>`, '@jay_alt'] });
    expect(getReminder(1)?.targetIds).toEqual([JASPER]);

    const result = await run('set_reminder', { text: 'gym', in_minutes: 5 }, { authorId: SIDE, authorDisplayName: 'JayAlt' });
    expect(result).toContain('set for Wheelie:');
    expect(getReminder(2)).toMatchObject({ requesterId: JASPER, requesterName: 'Wheelie', targetIds: [JASPER] });
  });

  it('lets the person cancel from either account', async () => {
    await run('set_reminder', { text: 'gym', in_minutes: 30, for: ['Wheelie'] });
    expect(await run('cancel_reminder', { id: 1 }, { authorId: SIDE, authorDisplayName: 'JayAlt' })).toBe(
      'Cancelled reminder #1 ("gym").',
    );
  });
});

describe('list_reminders', () => {
  it('lists this channel only, soonest first, with who and when in ET', async () => {
    await run('set_reminder', { text: 'later thing', in_minutes: 120 });
    await run('set_reminder', { text: 'soon thing', in_minutes: 10, for: ['Wheelie'] });
    await run('set_reminder', { text: 'elsewhere', in_minutes: 5 }, { channelId: 'channel-2' });

    const result = await run('list_reminders', {});
    expect(result).toBe(
      [
        '2 pending reminder(s) in this channel (now Fri 2026-09-25 14:00 ET):',
        '#2 · for Wheelie · Fri 2026-09-25 14:10 ET (in 10m) · "soon thing" (set by fridge enjoyer)',
        '#1 · for fridge enjoyer · Fri 2026-09-25 16:00 ET (in 2h) · "later thing" (set by fridge enjoyer)',
      ].join('\n'),
    );
  });

  it('says so when there are none', async () => {
    expect(await run('list_reminders', {})).toBe('No pending reminders in this channel.');
  });
});

describe('cancel_reminder', () => {
  it('lets the requester or a target cancel, and refuses anyone else', async () => {
    await run('set_reminder', { text: 'gym', in_minutes: 30, for: ['Wheelie'] });
    await run('set_reminder', { text: 'laundry', in_minutes: 30 });

    expect(await run('cancel_reminder', { id: 1 }, { authorId: STRANGER, authorDisplayName: 'Rando' })).toBe(
      "Rando can't cancel reminder #1: only the person who set it (fridge enjoyer) or someone it's for can.",
    );
    expect(await run('cancel_reminder', { id: '#1' }, { authorId: JASPER })).toBe('Cancelled reminder #1 ("gym").');
    expect(await run('cancel_reminder', { id: 2 })).toBe('Cancelled reminder #2 ("laundry").');
    expect(listPendingInChannel('channel-1')).toEqual([]);
  });

  it('explains unknown, finished and invalid ids', async () => {
    const id = insertReminder({
      guildId: null,
      channelId: 'channel-1',
      requesterId: REMI,
      requesterName: 'fridge enjoyer',
      targetIds: [REMI],
      text: 'old',
      dueAt: NOW.getTime() - 1000,
      sourceUrl: null,
      createdAt: 0,
    });
    await run('cancel_reminder', { id });
    expect(await run('cancel_reminder', { id })).toBe("Reminder #1 isn't pending anymore (already cancelled).");
    expect(await run('cancel_reminder', { id: 99 })).toBe("There's no reminder #99.");
    expect(await run('cancel_reminder', { id: 'abc' })).toBe('Invalid reminder id.');
  });
});

describe('create_poll', () => {
  it('posts a native poll in the channel', async () => {
    const { ctx, fake } = ctxFor({ sendImpl: async () => ({ id: 'poll-msg' }) });
    const result = await tool('create_poll').handler(ctx, {
      question: 'where we eating?',
      answers: ['pho', 'tacos'],
      duration_hours: 4,
    });
    expect(result).toContain('Poll posted (message id poll-msg)');
    expect(fake.recorders.send.calls[0][0]).toEqual({
      poll: {
        question: { text: 'where we eating?' },
        answers: [{ text: 'pho' }, { text: 'tacos' }],
        duration: 4,
        allowMultiselect: false,
      },
      allowedMentions: { parse: [] },
    });
  });

  it('returns validation errors without posting', async () => {
    const { ctx, fake } = ctxFor();
    const result = await tool('create_poll').handler(ctx, { question: 'q', answers: [], duration_hours: 2 });
    expect(result).toBe('No poll posted: The poll needs at least one answer.');
    expect(fake.recorders.send.calls).toHaveLength(0);
  });
});
