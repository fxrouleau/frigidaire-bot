import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBirthday, saveBirthday } from '../../scheduling/birthdayStore';
import { BotDb, setBotDbForTesting } from '../../storage/botDb';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { setMemoryStoreForTesting } from '../memory';
import { MemoryStore } from '../memory/memoryStore';
import { toolDefinitions } from '../tools';
import { type ToolDefinition, type ToolHandlerContext, createTurnEffects } from '../types';
import { birthdayTools } from './birthdays';

const FELIX = '700000000000000001';
const JASON = '700000000000000002';
const MARIE = '700000000000000003';
// Friday 2026-09-25 10:00 EDT
const NOW = new Date('2026-09-25T14:00:00Z');

function tool(name: string): ToolDefinition {
  const found = birthdayTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function run(name: string, args: Record<string, unknown>, authorId = FELIX) {
  const { message } = createFakeMessage({ authorId, authorDisplayName: authorId === FELIX ? 'fridge enjoyer' : 'x' });
  const ctx = { message, channelId: message.channel.id, turn: createTurnEffects() } as unknown as ToolHandlerContext;
  return tool(name).handler(ctx, args);
}

let memory: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  memory.upsertIdentity(FELIX, 'fridge enjoyer');
  memory.upsertIdentity(JASON, 'Wheezer');
  memory.updateIdentityMeta(JASON, { irl_name: 'Jason' });
  memory.upsertIdentity(MARIE, 'Marie');
});

afterEach(() => {
  vi.useRealTimers();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('tool registration', () => {
  it('offers set/list/forget birthday to the chat model', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['set_birthday', 'list_birthdays', 'forget_birthday']));
  });
});

describe('set_birthday', () => {
  it("saves the requester's birthday and says when the next one is", async () => {
    expect(await run('set_birthday', { person: 'me', date: '10-01' })).toBe(
      "Saved fridge enjoyer's birthday: October 1. Next one is in 6 day(s).",
    );
    expect(getBirthday(FELIX)).toMatchObject({ month: 10, day: 1, year: null, setBy: FELIX, lastAnnouncedYear: null });
  });

  it("saves someone else's birthday by IRL name, with the year", async () => {
    expect(await run('set_birthday', { person: 'Jason', date: '1994-12-03' })).toBe(
      "Saved Wheezer's birthday: December 3, 1994. Next one is in 69 day(s) (turning 32).",
    );
    expect(getBirthday(JASON)).toMatchObject({ month: 12, day: 3, year: 1994, setBy: FELIX });
  });

  it("marks a birthday that is today as announced, so the reply is the wish and there's no duplicate post", async () => {
    const result = await run('set_birthday', { person: 'Marie', date: '1996-09-25' });
    expect(result).toContain("That's today (turning 30)! Wish them in your reply");
    expect(getBirthday(MARIE)?.lastAnnouncedYear).toBe(2026);
  });

  it('keeps the announcement state for a same-day correction and resets it for a new date', async () => {
    saveBirthday({ userId: JASON, date: { month: 3, day: 1, year: null }, setBy: 'x', now: 0, lastAnnouncedYear: 2026 });
    await run('set_birthday', { person: 'Wheezer', date: '1990-03-01' });
    expect(getBirthday(JASON)).toMatchObject({ year: 1990, lastAnnouncedYear: 2026 });

    const moved = await run('set_birthday', { person: 'Wheezer', date: '03-02' });
    expect(moved).toContain('(was March 1, 1990)');
    expect(getBirthday(JASON)).toMatchObject({ month: 3, day: 2, year: null, lastAnnouncedYear: null });
  });

  it('refuses bad dates and unknown people without saving', async () => {
    expect(await run('set_birthday', { person: 'me', date: '02-30' })).toBe(
      "Nothing saved. February doesn't have a day 30.",
    );
    expect(await run('set_birthday', { person: 'Gandalf', date: '01-01' })).toMatch(
      /^Nothing saved\. I don't know who "Gandalf" is\./,
    );
    expect(getBirthday(FELIX)).toBeUndefined();
  });
});

describe('list_birthdays', () => {
  it('lists soonest first, today on top, with ages when known', async () => {
    saveBirthday({ userId: JASON, date: { month: 1, day: 2, year: 1990 }, setBy: 'x', now: 0, lastAnnouncedYear: null });
    saveBirthday({ userId: FELIX, date: { month: 9, day: 26, year: null }, setBy: 'x', now: 0, lastAnnouncedYear: null });
    saveBirthday({ userId: MARIE, date: { month: 9, day: 25, year: null }, setBy: 'x', now: 0, lastAnnouncedYear: null });
    saveBirthday({
      userId: '700000000000000009',
      date: { month: 9, day: 24, year: null },
      setBy: 'x',
      now: 0,
      lastAnnouncedYear: null,
    });

    expect(await run('list_birthdays', {})).toBe(
      [
        '4 birthday(s), soonest first:',
        '- Marie: September 25 (TODAY)',
        '- fridge enjoyer: September 26 (tomorrow)',
        '- Wheezer: January 2 (in 99 days, turning 37)',
        '- <@700000000000000009>: September 24 (in 364 days)',
      ].join('\n'),
    );
  });

  it('says so when empty', async () => {
    expect(await run('list_birthdays', {})).toBe('No birthdays saved yet.');
  });
});

describe('forget_birthday', () => {
  it('deletes a saved birthday and says when there was none', async () => {
    await run('set_birthday', { person: 'Wheezer', date: '01-02' });
    expect(await run('forget_birthday', { person: 'jason' })).toBe("Forgot Wheezer's birthday.");
    expect(getBirthday(JASON)).toBeUndefined();
    expect(await run('forget_birthday', { person: 'jason' })).toBe("I didn't have a birthday saved for Wheezer.");
  });
});
