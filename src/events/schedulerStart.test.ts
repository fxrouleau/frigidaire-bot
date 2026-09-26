import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReminder, insertReminder } from '../scheduling/reminderStore';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createPostableChannel, createSchedulingClient } from '../test-support/fakeScheduling';
import schedulerStart, { resetSchedulerForTesting } from './schedulerStart';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  setBotDbForTesting(new BotDb(':memory:'));
  vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('BIRTHDAYS_SEED', '');
});

afterEach(() => {
  resetSchedulerForTesting();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
});

describe('schedulerStart', () => {
  it('is a once-only ClientReady handler', () => {
    expect(schedulerStart.name).toBe('clientReady');
    expect(schedulerStart.once).toBe(true);
  });

  it('delivers reminders that came due while the bot was offline as soon as it is ready, only once', async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    const id = insertReminder({
      guildId: 'g',
      channelId: 'channel-1',
      requesterId: '800000000000000001',
      requesterName: 'Alice',
      targetIds: ['800000000000000001'],
      text: 'call mom',
      dueAt: Date.now() - 3_600_000,
      sourceUrl: null,
      sourcePrivate: false,
      createdAt: Date.now() - 7_200_000,
    });

    schedulerStart.execute(client);
    schedulerStart.execute(client);

    await vi.waitFor(() => expect(getReminder(id)?.status).toBe('sent'));
    expect(target.sent).toHaveLength(1);
    expect(String(target.sent[0].content)).toContain('call mom (late — I was offline)');
  });
});
