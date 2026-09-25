import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createPostableChannel, createSchedulingClient } from '../test-support/fakeScheduling';
import { getBirthday, saveBirthday } from './birthdayStore';
import { type NewReminder, getReminder, insertReminder } from './reminderStore';
import { SCHEDULER_TICK_MS, Scheduler } from './scheduler';

const NOW = Date.UTC(2026, 8, 25, 19, 30); // 15:30 EDT
const USER = '500000000000000001';

function reminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    guildId: 'g',
    channelId: 'channel-1',
    requesterId: USER,
    requesterName: 'Alice',
    targetIds: [USER],
    text: 'stretch',
    dueAt: NOW - 1000,
    sourceUrl: null,
    sourcePrivate: false,
    createdAt: NOW - 3_600_000,
    ...overrides,
  };
}

let scheduler: Scheduler | undefined;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('BIRTHDAY_CHANNEL_ID', 'channel-1');
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('BIRTHDAYS_SEED', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', '');
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
});

describe('Scheduler.tick', () => {
  it('delivers due reminders and announces birthdays in the same tick', async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    const id = insertReminder(reminder());
    saveBirthday({ userId: USER, date: { month: 9, day: 25, year: null }, setBy: 't', now: 0, lastAnnouncedYear: null });
    scheduler = new Scheduler({ client, now: () => NOW, birthdayWriter: async () => undefined });

    await scheduler.tick();

    expect(getReminder(id)?.status).toBe('sent');
    expect(getBirthday(USER)?.lastAnnouncedYear).toBe(2026);
    const contents = target.sent.map((m) => String(m.content));
    expect(contents.some((c) => c.startsWith('⏰'))).toBe(true);
    expect(contents.some((c) => c.startsWith('🎂'))).toBe(true);
  });

  it("doesn't let a slow birthday message hold up reminders", async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    saveBirthday({ userId: USER, date: { month: 9, day: 25, year: null }, setBy: 't', now: 0, lastAnnouncedYear: null });
    let finishWriting: ((text: string | undefined) => void) | undefined;
    const writer = () =>
      new Promise<string | undefined>((resolve) => {
        finishWriting = resolve;
      });
    let now = NOW;
    scheduler = new Scheduler({ client, now: () => now, birthdayWriter: writer });

    const firstTick = scheduler.tick(); // the birthday job is now stuck on the model call
    await vi.waitFor(() => expect(finishWriting).not.toBeUndefined());

    now = NOW + SCHEDULER_TICK_MS;
    const id = insertReminder(reminder({ dueAt: now - 1000 }));
    await scheduler.tick();
    expect(getReminder(id)?.status).toBe('sent');

    finishWriting?.(undefined);
    await firstTick;
    expect(getBirthday(USER)?.lastAnnouncedYear).toBe(2026);
    // The overlapping tick skipped the busy birthday job instead of announcing twice.
    expect(target.sent.filter((m) => String(m.content).startsWith('🎂'))).toHaveLength(1);
  });

  it('survives a job throwing', async () => {
    const { client } = createSchedulingClient({});
    insertReminder(reminder({ channelId: 'missing' }));
    scheduler = new Scheduler({ client, now: () => NOW });
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });
});

describe('Scheduler.start', () => {
  it('applies BIRTHDAYS_SEED, ticks immediately, then every interval (idempotently)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.stubEnv('BIRTHDAYS_SEED', `${USER}:03-14`);
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    insertReminder(reminder());
    let now = NOW;
    scheduler = new Scheduler({ client, now: () => now });

    scheduler.start();
    scheduler.start();

    expect(getBirthday(USER)).toMatchObject({ month: 3, day: 14, setBy: 'seed' });
    await vi.waitFor(() => expect(target.sent).toHaveLength(1));

    now = NOW + 2 * SCHEDULER_TICK_MS;
    const later = insertReminder(reminder({ dueAt: now - 1000 }));
    vi.advanceTimersByTime(SCHEDULER_TICK_MS);
    await vi.waitFor(() => expect(getReminder(later)?.status).toBe('sent'));
    expect(target.sent).toHaveLength(2);
  });
});
