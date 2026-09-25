import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import {
  type NewReminder,
  cancelReminder,
  claimDueReminders,
  countOpenByRequester,
  getReminder,
  insertReminder,
  listPendingInChannel,
  markFailed,
  markRetry,
  markSent,
  pruneFinished,
  releaseStaleClaims,
} from './reminderStore';

const T0 = Date.UTC(2026, 8, 25, 18, 0, 0);

function reminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    requesterId: 'alice',
    requesterName: 'Alice',
    targetIds: ['alice'],
    text: 'take the pizza out',
    dueAt: T0 + 60_000,
    sourceUrl: 'https://discord.com/channels/guild-1/channel-1/msg-1',
    createdAt: T0,
    ...overrides,
  };
}

let db: BotDb;

beforeEach(() => {
  db = new BotDb(':memory:');
  setBotDbForTesting(db);
});

afterEach(() => {
  setBotDbForTesting(undefined);
});

describe('reminder rows', () => {
  it('round-trips every stored field', () => {
    const id = insertReminder(reminder({ targetIds: ['alice', 'bob'] }));
    expect(getReminder(id)).toEqual({
      id,
      guildId: 'guild-1',
      channelId: 'channel-1',
      requesterId: 'alice',
      requesterName: 'Alice',
      targetIds: ['alice', 'bob'],
      text: 'take the pizza out',
      dueAt: T0 + 60_000,
      sourceUrl: 'https://discord.com/channels/guild-1/channel-1/msg-1',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      createdAt: T0,
    });
  });

  it('never reuses an id, even after pruning', () => {
    const first = insertReminder(reminder({ dueAt: T0 - 90 * 86_400_000 }));
    db.stmt("UPDATE reminders SET status = 'sent' WHERE id = ?").run(first);
    expect(pruneFinished(T0, 30 * 86_400_000)).toBe(1);
    expect(insertReminder(reminder())).toBeGreaterThan(first);
  });

  it('lists pending reminders per channel, soonest first, and counts open ones per requester', () => {
    const later = insertReminder(reminder({ dueAt: T0 + 120_000 }));
    const sooner = insertReminder(reminder({ dueAt: T0 + 60_000 }));
    insertReminder(reminder({ channelId: 'other', requesterId: 'bob' }));
    const cancelled = insertReminder(reminder());
    cancelReminder(cancelled, 'alice');

    expect(listPendingInChannel('channel-1').map((r) => r.id)).toEqual([sooner, later]);
    expect(countOpenByRequester('alice')).toBe(2);
    expect(countOpenByRequester('bob')).toBe(1);
  });
});

describe('cancelReminder', () => {
  it('lets the requester or a target cancel, nobody else', () => {
    const id = insertReminder(reminder({ targetIds: ['bob'] }));
    expect(cancelReminder(id, 'mallory').outcome).toBe('forbidden');
    expect(cancelReminder(id, 'bob').outcome).toBe('cancelled');
    expect(getReminder(id)?.status).toBe('cancelled');
    expect(cancelReminder(id, 'alice').outcome).toBe('not_pending');
    expect(cancelReminder(9999, 'alice').outcome).toBe('not_found');
  });

  it("can't cancel a reminder that is being delivered or already went off", () => {
    const id = insertReminder(reminder());
    claimDueReminders(T0 + 60_000, 10);
    expect(cancelReminder(id, 'alice').outcome).toBe('not_pending');
  });
});

describe('claiming for delivery', () => {
  it('claims only due reminders, exactly once', () => {
    const due = insertReminder(reminder({ dueAt: T0 }));
    insertReminder(reminder({ dueAt: T0 + 3_600_000 }));

    const claimed = claimDueReminders(T0, 10);
    expect(claimed.map((r) => r.id)).toEqual([due]);
    expect(claimed[0]).toMatchObject({ status: 'sending', attempts: 1 });
    // A second (overlapping) claim finds nothing: the row is no longer pending.
    expect(claimDueReminders(T0, 10)).toEqual([]);
  });

  it('respects the batch limit and delivers the oldest first', () => {
    const ids = [3, 1, 2].map((n) => insertReminder(reminder({ dueAt: T0 - n * 1000 })));
    expect(claimDueReminders(T0, 2).map((r) => r.id)).toEqual([ids[0], ids[2]]);
  });

  it('holds a retried reminder back until its next attempt time', () => {
    const id = insertReminder(reminder({ dueAt: T0 }));
    claimDueReminders(T0, 10);
    markRetry(id, 'boom', T0 + 60_000);
    expect(getReminder(id)).toMatchObject({ status: 'pending', nextAttemptAt: T0 + 60_000, attempts: 1 });
    expect(claimDueReminders(T0 + 30_000, 10)).toEqual([]);
    expect(claimDueReminders(T0 + 60_000, 10).map((r) => r.id)).toEqual([id]);
    expect(getReminder(id)?.attempts).toBe(2);
  });

  it('marks sent and failed rows so they are never claimed again', () => {
    const sent = insertReminder(reminder({ dueAt: T0 }));
    const failed = insertReminder(reminder({ dueAt: T0 }));
    claimDueReminders(T0, 10);
    markSent(sent, { messageId: 'm-1', channelId: 'channel-1', at: T0 });
    markFailed(failed, 'gone');
    expect(getReminder(sent)?.status).toBe('sent');
    expect(getReminder(failed)?.status).toBe('failed');
    expect(claimDueReminders(T0 + 86_400_000, 10)).toEqual([]);
  });

  it('releases claims left behind by a process that died mid-send', () => {
    const id = insertReminder(reminder({ dueAt: T0 }));
    claimDueReminders(T0, 10);
    expect(releaseStaleClaims(T0 + 60_000, 5 * 60_000)).toBe(0);
    expect(releaseStaleClaims(T0 + 6 * 60_000, 5 * 60_000)).toBe(1);
    expect(getReminder(id)?.status).toBe('pending');
  });
});

describe('pruneFinished', () => {
  it('deletes only old finished reminders', () => {
    const oldSent = insertReminder(reminder({ dueAt: T0 - 40 * 86_400_000 }));
    const oldPending = insertReminder(reminder({ dueAt: T0 - 40 * 86_400_000 }));
    const recentSent = insertReminder(reminder({ dueAt: T0 - 86_400_000 }));
    db.stmt("UPDATE reminders SET status = 'sent' WHERE id IN (?, ?)").run(oldSent, recentSent);

    expect(pruneFinished(T0, 30 * 86_400_000)).toBe(1);
    expect(getReminder(oldSent)).toBeUndefined();
    expect(getReminder(oldPending)).toBeDefined();
    expect(getReminder(recentSent)).toBeDefined();
  });
});
