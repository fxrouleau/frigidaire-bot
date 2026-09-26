import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { createPostableChannel, createSchedulingClient, discordError } from '../test-support/fakeScheduling';
import { MAX_SEND_ATTEMPTS, deliverDueReminders, renderReminder } from './reminderDelivery';
import { type NewReminder, type Reminder, getReminder, insertReminder } from './reminderStore';

const ALICE = '200000000000000001';
const BOB = '200000000000000002';
// 2026-09-25 14:00 EDT
const NOW = Date.UTC(2026, 8, 25, 18, 0, 0);
const MINUTE = 60_000;

function newReminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    requesterId: ALICE,
    requesterName: 'Alice',
    targetIds: [ALICE, BOB],
    text: 'take the pizza out',
    dueAt: NOW,
    sourceUrl: 'https://discord.com/channels/guild-1/channel-1/msg-1',
    sourcePrivate: false,
    createdAt: NOW - 30 * MINUTE,
    ...overrides,
  };
}

function asReminder(input: NewReminder, id = 7): Reminder {
  return { ...input, id, status: 'sending', attempts: 1, nextAttemptAt: null };
}

let memory: MemoryStore;

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('renderReminder', () => {
  it('pings the targets and credits the requester with the source link', () => {
    const text = renderReminder(asReminder(newReminder()), { now: NOW + 10_000, startedAt: NOW - 3_600_000 });
    expect(text).toBe(
      `⏰ <@${ALICE}> <@${BOB}> take the pizza out\n-# set by Alice · https://discord.com/channels/guild-1/channel-1/msg-1`,
    );
  });

  it("uses the requester's current display name", () => {
    memory.upsertIdentity(ALICE, 'Alice the Great');
    const text = renderReminder(asReminder(newReminder()), { now: NOW, startedAt: NOW - 3_600_000 });
    expect(text).toContain('-# set by Alice the Great');
  });

  it('flags a reminder that came due while the bot was offline', () => {
    const text = renderReminder(asReminder(newReminder({ dueAt: NOW - 20 * MINUTE })), {
      now: NOW,
      startedAt: NOW - 10_000,
    });
    expect(text).toContain('take the pizza out (late — I was offline)');
    expect(text).toContain('was due 1:40 PM ET');
  });

  it('shows the full date when it is more than half a day late', () => {
    const text = renderReminder(asReminder(newReminder({ dueAt: NOW - 2 * 86_400_000 })), {
      now: NOW,
      startedAt: NOW,
    });
    expect(text).toContain('was due Wed 2026-09-23 14:00 ET');
  });

  it('does not call a reminder due seconds before startup late', () => {
    const text = renderReminder(asReminder(newReminder({ dueAt: NOW - 20_000 })), { now: NOW, startedAt: NOW - 5_000 });
    expect(text).not.toContain('late');
  });

  it('calls a retried reminder late without blaming downtime', () => {
    const text = renderReminder(asReminder(newReminder({ dueAt: NOW - 10 * MINUTE })), {
      now: NOW,
      startedAt: NOW - 3_600_000,
    });
    expect(text).toContain('take the pizza out (late)\n');
  });

  it('says where it could not post when redirected', () => {
    const text = renderReminder(asReminder(newReminder()), {
      now: NOW,
      startedAt: NOW - 3_600_000,
      redirectedFrom: 'channel-1',
    });
    expect(text).toContain("couldn't post in <#channel-1>");
  });
});

describe('deliverDueReminders', () => {
  it('posts a due reminder once, with mentions limited to its targets and a dedup nonce', async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    const id = insertReminder(newReminder());
    insertReminder(newReminder({ dueAt: NOW + 3_600_000 }));

    const report = await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });

    expect(report).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]).toMatchObject({
      allowedMentions: { parse: [], users: [ALICE, BOB] },
      nonce: `reminder-${id}`,
      enforceNonce: true,
    });
    expect(String(target.sent[0].content)).toMatch(/^⏰ <@200000000000000001> <@200000000000000002> take the pizza out/);
    expect(String(target.sent[0].nonce).length).toBeLessThanOrEqual(25);
    expect(getReminder(id)?.status).toBe('sent');

    // The next tick has nothing left to post.
    await deliverDueReminders({ client, now: NOW + 30_000, startedAt: NOW - 3_600_000 });
    expect(target.sent).toHaveLength(1);
  });

  it('never double-posts when two ticks overlap', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = createPostableChannel({
      id: 'channel-1',
      sendImpl: async () => {
        await gate;
        return { id: 'posted' };
      },
    });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    insertReminder(newReminder());

    const first = deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });
    const second = deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });
    release();
    await Promise.all([first, second]);

    expect(target.channel.send.calls).toHaveLength(1);
  });

  it('posts reminders missed while offline with the late marker', async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    insertReminder(newReminder({ dueAt: NOW - 3 * 3_600_000 }));

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 5_000 });

    expect(String(target.sent[0].content)).toContain('(late — I was offline)');
  });

  it('retries a failed send with backoff, then gives up after the last attempt', async () => {
    const target = createPostableChannel({
      id: 'channel-1',
      sendImpl: async () => {
        throw new Error('Service Unavailable');
      },
    });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    const id = insertReminder(newReminder());

    let now = NOW;
    const first = await deliverDueReminders({ client, now, startedAt: NOW - 3_600_000 });
    expect(first).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(getReminder(id)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: NOW + MINUTE });

    // Held back until the backoff elapses.
    await deliverDueReminders({ client, now: now + 30_000, startedAt: NOW - 3_600_000 });
    expect(target.channel.send.calls).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      now = getReminder(id)?.nextAttemptAt ?? now;
      await deliverDueReminders({ client, now, startedAt: NOW - 3_600_000 });
    }
    expect(target.channel.send.calls).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(getReminder(id)?.status).toBe('failed');
  });

  it('succeeds on a retry after a transient failure', async () => {
    let calls = 0;
    const target = createPostableChannel({
      id: 'channel-1',
      sendImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return { id: 'posted' };
      },
    });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    const id = insertReminder(newReminder());

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });
    await deliverDueReminders({ client, now: NOW + MINUTE, startedAt: NOW - 3_600_000 });

    expect(getReminder(id)?.status).toBe('sent');
    expect(target.sent).toHaveLength(1);
    // Same nonce on the retry, so Discord can dedupe a send that actually went through.
    expect(target.channel.send.calls.map(([options]) => options.nonce)).toEqual([`reminder-${id}`, `reminder-${id}`]);
  });

  it('falls back to the main channel when the original channel is gone', async () => {
    const main = createPostableChannel({ id: 'main' });
    const { client } = createSchedulingClient({ main: main.channel });
    const id = insertReminder(newReminder({ channelId: 'deleted-thread' }));

    const report = await deliverDueReminders({
      client,
      now: NOW,
      startedAt: NOW - 3_600_000,
      fallbackChannelId: 'main',
    });

    expect(report.sent).toBe(1);
    expect(String(main.sent[0].content)).toContain('take the pizza out');
    expect(String(main.sent[0].content)).toContain("couldn't post in <#deleted-thread>");
    expect(getReminder(id)?.status).toBe('sent');
  });

  it('never repeats the text of a reminder set somewhere private when it falls back to the main channel', async () => {
    const main = createPostableChannel({ id: 'main' });
    const { client } = createSchedulingClient({ main: main.channel });
    const id = insertReminder(newReminder({ channelId: 'private-thread', text: 'buy the surprise cake', sourcePrivate: true }));

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000, fallbackChannelId: 'main' });

    const content = String(main.sent[0].content);
    expect(content).not.toContain('cake');
    expect(content).toBe(
      `⏰ <@${ALICE}> <@${BOB}> reminder #${id} is due, but it was set somewhere private, so its text stays there\n` +
        "-# set by Alice · https://discord.com/channels/guild-1/channel-1/msg-1 · couldn't post in <#private-thread>",
    );
    expect(main.sent[0].allowedMentions).toEqual({ parse: [], users: [ALICE, BOB] });
    expect(getReminder(id)?.status).toBe('sent');
  });

  it('posts a private reminder in full in its own channel', async () => {
    const thread = createPostableChannel({ id: 'private-thread' });
    const { client } = createSchedulingClient({ 'private-thread': thread.channel });
    insertReminder(newReminder({ channelId: 'private-thread', text: 'buy the surprise cake', sourcePrivate: true }));

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000, fallbackChannelId: 'main' });

    expect(String(thread.sent[0].content)).toContain('buy the surprise cake');
  });

  it('pings every linked account of a target, so a member on their side account still gets it', async () => {
    const SIDE = '200000000000000009';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${ALICE}`);
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    insertReminder(newReminder());

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });

    expect(String(target.sent[0].content)).toMatch(/^⏰ <@200000000000000001> <@200000000000000009> <@200000000000000002> take/);
    expect(target.sent[0].allowedMentions).toEqual({ parse: [], users: [ALICE, SIDE, BOB] });
  });

  it('falls back to the main channel when it may not post in the original one', async () => {
    const locked = createPostableChannel({
      id: 'channel-1',
      sendImpl: async () => {
        throw discordError(50013, 'Missing Permissions');
      },
    });
    const main = createPostableChannel({ id: 'main' });
    const { client } = createSchedulingClient({ 'channel-1': locked.channel, main: main.channel });
    insertReminder(newReminder());

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000, fallbackChannelId: 'main' });

    expect(main.sent).toHaveLength(1);
  });

  it('does not redirect on a transient error', async () => {
    const flaky = createPostableChannel({
      id: 'channel-1',
      sendImpl: async () => {
        throw new Error('socket hang up');
      },
    });
    const main = createPostableChannel({ id: 'main' });
    const { client } = createSchedulingClient({ 'channel-1': flaky.channel, main: main.channel });
    insertReminder(newReminder());

    const report = await deliverDueReminders({
      client,
      now: NOW,
      startedAt: NOW - 3_600_000,
      fallbackChannelId: 'main',
    });

    expect(report.retried).toBe(1);
    expect(main.sent).toHaveLength(0);
  });

  it('pings the requester when the stored target list is empty', async () => {
    const target = createPostableChannel({ id: 'channel-1' });
    const { client } = createSchedulingClient({ 'channel-1': target.channel });
    insertReminder(newReminder({ targetIds: [] }));

    await deliverDueReminders({ client, now: NOW, startedAt: NOW - 3_600_000 });

    expect(target.sent[0].allowedMentions).toEqual({ parse: [], users: [ALICE] });
    expect(String(target.sent[0].content)).toMatch(/^⏰ <@200000000000000001> take/);
  });
});
