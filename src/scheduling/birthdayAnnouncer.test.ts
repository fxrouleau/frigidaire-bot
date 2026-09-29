import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNotesStore, setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { FEATURE_HEADER } from '../ai/usage';
import { ArchiveStore, setArchiveStoreForTesting } from '../archive/archiveStore';
import { BotDb, setBotDbForTesting } from '../storage/botDb';
import { archiveInput } from '../test-support/fakeArchive';
import { createPostableChannel, createSchedulingClient } from '../test-support/fakeScheduling';
import {
  BirthdayAnnouncer,
  type BirthdayMessageInput,
  type BirthdayWriter,
  createBirthdayWriter,
  fallbackBirthdayMessage,
  finalizeBirthdayMessage,
} from './birthdayAnnouncer';
import { getBirthday, saveBirthday } from './birthdayStore';

const ALICE = '400000000000000001';
const BOB = '400000000000000002';
const CHANNEL = 'birthday-channel';

// Eastern wall-clock instants (EDT = UTC-4 in September).
const SEPT25_1459 = Date.UTC(2026, 8, 25, 18, 59);
const SEPT25_1500 = Date.UTC(2026, 8, 25, 19, 0);
const SEPT25_2330 = Date.UTC(2026, 8, 26, 3, 30);
const SEPT26_1600 = Date.UTC(2026, 8, 26, 20, 0);

let memory: MemoryStore;

function birthday(userId: string, month: number, day: number, year: number | null = null, lastAnnouncedYear = null) {
  saveBirthday({ userId, date: { month, day, year }, setBy: 'test', now: 0, lastAnnouncedYear });
}

// Well before the Sept 25 runs below: "3mo ago" by then.
const LONG_AGO = '2026-06-01 12:00:00';

/** Sets a memory's SQLite timestamps (UTC 'YYYY-MM-DD HH:MM:SS'); saves always stamp the real clock. */
function stamp(id: number, createdAt: string, updatedAt = createdAt): void {
  const db = (memory as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
  db.prepare(
    'UPDATE memories SET created_at = ?, updated_at = ?, first_seen_at = ?, last_seen_at = ? WHERE id = ?',
  ).run(createdAt, updatedAt, createdAt, updatedAt, id);
}

async function saveOld(input: Parameters<MemoryStore['save']>[0]): Promise<number> {
  const id = await memory.save(input);
  stamp(id, LONG_AGO);
  return id;
}

function writerSaying(text: string | undefined) {
  const inputs: BirthdayMessageInput[] = [];
  const writer: BirthdayWriter = async (input) => {
    inputs.push(input);
    return text;
  };
  return { writer, inputs };
}

function setup(opts: { writer?: BirthdayWriter; members?: Array<{ id: string; displayName: string }> } = {}) {
  const target = createPostableChannel({ id: CHANNEL, members: opts.members });
  const { client } = createSchedulingClient({ [CHANNEL]: target.channel });
  const announcer = new BirthdayAnnouncer({ client, writer: opts.writer ?? writerSaying('🎂 happy bday').writer });
  return { target, client, announcer };
}

beforeEach(() => {
  setBotDbForTesting(new BotDb(':memory:'));
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  vi.stubEnv('BIRTHDAY_CHANNEL_ID', CHANNEL);
  vi.stubEnv('MAIN_CHANNEL_ID', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', '');
  vi.stubEnv('BIRTHDAY_ANNOUNCE_MODE', 'on');
});

afterEach(() => {
  vi.unstubAllEnvs();
  setBotDbForTesting(undefined);
  setMemoryStoreForTesting(undefined);
});

describe('BirthdayAnnouncer shadow mode', () => {
  const REPORT = 'report-channel';

  function shadowSetup() {
    const target = createPostableChannel({ id: CHANNEL });
    const report = createPostableChannel({ id: REPORT });
    const { client } = createSchedulingClient({ [CHANNEL]: target.channel, [REPORT]: report.channel });
    const announcer = new BirthdayAnnouncer({ client, writer: writerSaying(`🎂 <@${ALICE}> old now`).writer });
    return { target, report, announcer };
  }

  it('is the default: posts the message to the report channel only, once, without touching the real watermark', async () => {
    vi.stubEnv('BIRTHDAY_ANNOUNCE_MODE', '');
    vi.stubEnv('REPORT_CHANNEL_ID', REPORT);
    birthday(ALICE, 9, 25);
    const { target, report, announcer } = shadowSetup();

    expect(await announcer.run(SEPT25_1500)).toBe(1);
    expect(target.sent).toHaveLength(0);
    expect(report.sent).toHaveLength(1);
    expect(report.sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(String(report.sent[0].content)).toContain(`birthday (shadow) · would post in <#${CHANNEL}>`);
    expect(String(report.sent[0].content)).toContain(`🎂 <@${ALICE}> old now`);
    expect(getBirthday(ALICE)).toMatchObject({ lastAnnouncedYear: null, lastShadowYear: 2026 });

    expect(await announcer.run(SEPT25_1500 + 30_000)).toBe(0);
    expect(report.sent).toHaveLength(1);

    // Switched to on the same day: the real announcement still goes out.
    vi.stubEnv('BIRTHDAY_ANNOUNCE_MODE', 'on');
    expect(await announcer.run(SEPT25_1500 + 60_000)).toBe(1);
    expect(target.sent).toHaveLength(1);
  });

  it('does nothing without a report channel', async () => {
    vi.stubEnv('BIRTHDAY_ANNOUNCE_MODE', 'shadow');
    vi.stubEnv('REPORT_CHANNEL_ID', '');
    birthday(ALICE, 9, 25);
    const { target, announcer } = shadowSetup();
    expect(await announcer.run(SEPT25_1500)).toBe(0);
    expect(target.sent).toHaveLength(0);
    expect(getBirthday(ALICE)?.lastShadowYear).toBeNull();
  });
});

describe('BirthdayAnnouncer.run', () => {
  it('waits for the afternoon, then announces once with a ping limited to the birthday person', async () => {
    birthday(ALICE, 9, 25);
    birthday(BOB, 9, 26);
    const { writer } = writerSaying(`🎂 <@${ALICE}> another year closer to the grave`);
    const { target, announcer } = setup({ writer });

    expect(await announcer.run(SEPT25_1459)).toBe(0);
    expect(target.sent).toHaveLength(0);

    expect(await announcer.run(SEPT25_1500)).toBe(1);
    expect(target.sent).toHaveLength(1);
    expect(target.sent[0]).toMatchObject({
      content: `🎂 <@${ALICE}> another year closer to the grave`,
      allowedMentions: { parse: [], users: [ALICE] },
      enforceNonce: true,
    });
    expect(String(target.sent[0].nonce).length).toBeLessThanOrEqual(25);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);

    // Later ticks the same day post nothing more.
    expect(await announcer.run(SEPT25_1500 + 30_000)).toBe(0);
    expect(target.sent).toHaveLength(1);
  });

  it('is restart-safe: a fresh announcer does not repeat this year', async () => {
    birthday(ALICE, 9, 25);
    await setup().announcer.run(SEPT25_1500);

    const afterRestart = setup();
    expect(await afterRestart.announcer.run(SEPT25_1500 + 60_000)).toBe(0);
    expect(afterRestart.target.sent).toHaveLength(0);
  });

  it('announces late the same evening if the bot was offline all afternoon, but never the next day', async () => {
    birthday(ALICE, 9, 25);
    const lateSameDay = setup();
    expect(await lateSameDay.announcer.run(SEPT25_2330)).toBe(1);

    birthday(BOB, 9, 25);
    const nextDay = setup();
    expect(await nextDay.announcer.run(SEPT26_1600)).toBe(0);
    expect(getBirthday(BOB)?.lastAnnouncedYear).toBeNull();
  });

  it('announces a Feb 29 birthday on Feb 28 in a common year', async () => {
    birthday(ALICE, 2, 29);
    const { target, announcer } = setup();
    expect(await announcer.run(Date.UTC(2027, 1, 28, 21, 0))).toBe(1); // 16:00 EST
    expect(target.sent).toHaveLength(1);
  });

  it('respects BIRTHDAY_ANNOUNCE_HOUR', async () => {
    vi.stubEnv('BIRTHDAY_ANNOUNCE_HOUR', '9');
    birthday(ALICE, 9, 25);
    const { announcer } = setup();
    expect(await announcer.run(Date.UTC(2026, 8, 25, 12, 59))).toBe(0); // 08:59 EDT
    expect(await announcer.run(Date.UTC(2026, 8, 25, 13, 0))).toBe(1); // 09:00 EDT
  });

  it('is off without a channel (BIRTHDAY_CHANNEL_ID and MAIN_CHANNEL_ID unset) or when disabled', async () => {
    birthday(ALICE, 9, 25);
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
    const off = setup();
    expect(await off.announcer.run(SEPT25_1500)).toBe(0);

    vi.stubEnv('BIRTHDAY_CHANNEL_ID', CHANNEL);
    vi.stubEnv('BIRTHDAY_ANNOUNCE_ENABLED', 'false');
    const disabled = setup();
    expect(await disabled.announcer.run(SEPT25_1500)).toBe(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();
  });

  it('defaults to MAIN_CHANNEL_ID', async () => {
    vi.stubEnv('BIRTHDAY_CHANNEL_ID', '');
    vi.stubEnv('MAIN_CHANNEL_ID', CHANNEL);
    birthday(ALICE, 9, 25);
    const { target, announcer } = setup();
    await announcer.run(SEPT25_1500);
    expect(target.sent).toHaveLength(1);
  });

  it('falls back to the template when the writer has nothing or throws', async () => {
    birthday(ALICE, 9, 25, 1996);
    birthday(BOB, 9, 25);
    const failing = setup({ writer: writerSaying(undefined).writer });
    await failing.announcer.run(SEPT25_1500);
    expect(failing.target.sent.map((m) => m.content).sort()).toEqual(
      [`🎂 Happy 30th birthday <@${ALICE}>!`, `🎂 Happy birthday <@${BOB}>!`].sort(),
    );

    birthday(ALICE, 9, 25, 1996);
    const throwing = setup({
      writer: async () => {
        throw new Error('model exploded');
      },
    });
    expect(await throwing.announcer.run(SEPT25_1500)).toBe(1);
    expect(throwing.target.sent[0].content).toBe(`🎂 Happy 30th birthday <@${ALICE}>!`);
  });

  it("hands the writer their name, age, today's date and what it knows about them, dated", async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    const facts = [
      'works night shifts as an ER nurse',
      'owns two greyhounds named Salt and Pepper',
      'refuses to eat cilantro',
      'mains Thresh in League',
      'moved to Montreal last spring',
      'collects vintage film cameras',
      'is training for a half marathon',
    ];
    for (const content of facts) await saveOld({ category: 'fact', subject: 'Alice', content });
    await saveOld({ category: 'image', subject: 'Alice', content: 'shared a cat gif', subject_user_id: ALICE });
    birthday(ALICE, 9, 25, 1990);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice (server nick)' }] });

    await announcer.run(SEPT25_1500);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      userId: ALICE,
      name: 'Alice (server nick)',
      age: 36,
      botName: 'Frigidaire',
      today: 'Friday, September 25, 2026',
    });
    expect(inputs[0].memories).toEqual(facts.map((fact) => `${fact} (noted 3mo ago)`));
    expect(inputs[0].memories.join(' ')).not.toContain('cat gif');
  });

  it('lists them oldest first by when they were first noted, recent news and events included, each with its age', async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    const save = (category: string, content: string) =>
      memory.save({ category, subject: 'Alice', content, subject_user_id: ALICE });
    stamp(await save('fact', 'broke a toe at the climbing gym'), '2026-09-23 12:00:00');
    // Old lore the learner re-confirmed yesterday: created_at says how old it is, not updated_at.
    stamp(await save('personality', 'is late to everything, famously'), '2025-11-02 20:00:00', '2026-09-24 12:00:00');
    stamp(await save('event', 'is flying to Lisbon for the long weekend'), '2026-09-20 12:00:00');
    stamp(await save('preference', 'only drinks oat milk lattes'), 'not a timestamp');
    stamp(await save('image', 'shared a blurry concert photo'), '2026-09-24 12:00:00');
    birthday(ALICE, 9, 25);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

    await announcer.run(SEPT25_1500);

    // An unreadable time counts as old and gets no age; image shares never make it.
    expect(inputs[0].memories).toEqual([
      'only drinks oat milk lattes',
      'is late to everything, famously (noted 10mo ago)',
      'is flying to Lisbon for the long weekend (noted 5d ago)',
      'broke a toe at the climbing gym (noted 2d ago)',
    ]);
  });

  it('gives the writer their profile (Earlier left out) and only what was picked up since, once notes exist', async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    stamp(
      await memory.save({ category: 'fact', subject: 'Alice', content: 'is a nurse', subject_user_id: ALICE }),
      LONG_AGO,
    );
    const notes = getNotesStore(memory);
    notes.writeNotes(
      { scope: 'person', ownerId: ALICE },
      [
        {
          topic: 'profile',
          title: 'Alice',
          content: '## Now\nA nurse who runs the group movie nights.\n\n## Earlier\n- Back in 2017 lived in Quebec City.',
        },
      ],
      { updatedBy: 'dream' },
    );
    notes.recordDreamSuccess({ scope: 'person', ownerId: ALICE }, notes.journalHighWater());
    stamp(
      await memory.save({ category: 'event', subject: 'Alice', content: 'broke a toe', subject_user_id: ALICE }),
      '2026-09-23 12:00:00',
    );
    birthday(ALICE, 9, 25);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

    await announcer.run(SEPT25_1500);

    expect(inputs[0].profile).toBe('## Now\nA nurse who runs the group movie nights.');
    expect(inputs[0].memories).toEqual(['broke a toe (noted 2d ago)']);
  });

  it("marks a correction as whose word it is: someone else's claim never reads as the person's fact", async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    memory.upsertIdentity(BOB, 'Bob');
    stamp(
      await memory.save({
        category: 'correction',
        subject: 'Alice',
        content: 'Hates cilantro, actually',
        subject_user_id: ALICE,
        said_by: BOB,
      }),
      '2026-09-23 12:00:00',
    );
    stamp(
      await memory.save({
        category: 'correction',
        subject: 'Alice',
        content: 'Works days now, not nights',
        subject_user_id: ALICE,
        said_by: ALICE,
      }),
      '2026-09-24 12:00:00',
    );
    birthday(ALICE, 9, 25);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

    await announcer.run(SEPT25_1500);

    expect(inputs[0].memories).toEqual([
      "Hates cilantro, actually (a correction, Bob's claim, not settled; noted 2d ago)",
      'Works days now, not nights (a correction, their own word; noted 1d ago)',
    ]);
  });

  it('keeps the oldest 20 and the newest 20 when there are more than 40', async () => {
    memory.upsertIdentity(ALICE, 'Alice');
    for (let i = 0; i < 50; i++) {
      const id = await memory.save({
        category: 'fact',
        subject: 'Alice',
        content: `collects item${i} and thing${i}`,
        subject_user_id: ALICE,
      });
      // Day i of 2025: memory i is older than memory i + 1.
      stamp(id, new Date(Date.UTC(2025, 0, 1 + i, 12)).toISOString().slice(0, 19).replace('T', ' '));
    }
    birthday(ALICE, 9, 25);
    const { writer, inputs } = writerSaying('🎂 hbd');
    const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

    await announcer.run(SEPT25_1500);

    const items = inputs[0].memories.map((m) => Number(/item(\d+)/.exec(m)?.[1]));
    expect(items).toEqual([...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 20 }, (_, i) => 30 + i)]);
  });

  it("finds memories filed under any name they go by: Discord handle, and a linked side account's names", async () => {
    const SIDE = '400000000000000003';
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${ALICE}`);
    try {
      memory.upsertIdentity(ALICE, 'Alice', 'alice_handle');
      memory.upsertIdentity(SIDE, 'AliceAlt', 'alice_alt');
      await saveOld({ category: 'fact', subject: 'alice_handle', content: 'works night shifts as an ER nurse' });
      await saveOld({ category: 'fact', subject: 'AliceAlt', content: 'owns two greyhounds' });
      await saveOld({ category: 'fact', subject: 'Bob', content: 'mains Thresh in League' });
      birthday(ALICE, 9, 25);
      const { writer, inputs } = writerSaying('🎂 hbd');
      const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

      await announcer.run(SEPT25_1500);

      expect([...inputs[0].memories].sort()).toEqual([
        'owns two greyhounds (noted 3mo ago)',
        'works night shifts as an ER nurse (noted 3mo ago)',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("hands the writer the birthday channel's chat so far today, newest last, as plain lines", async () => {
    const archive = new ArchiveStore(':memory:');
    setArchiveStoreForTesting(archive);
    try {
      memory.upsertIdentity(ALICE, 'Alice');
      memory.upsertIdentity(BOB, 'Bob');
      // Sept 25 ET runs from 04:00 UTC; the run is at 19:00 UTC (15:00 ET).
      const at = (hour: number, minute: number) => Date.UTC(2026, 8, 25, hour, minute);
      archive.upsertMessages([
        archiveInput({ channelId: CHANNEL, authorId: BOB, authorName: 'Bob', content: 'yesterday stuff', createdAt: Date.UTC(2026, 8, 25, 3, 59) }),
        archiveInput({ channelId: CHANNEL, authorId: BOB, authorName: 'Bob', content: `morning <@${ALICE}> <:kek:123456789012345678>`, createdAt: at(13, 5) }),
        archiveInput({ channelId: CHANNEL, authorId: ALICE, authorName: 'Alice', content: '', transcript: 'nobody remembers anything', hasAudio: true, createdAt: at(14, 0) }),
        archiveInput({ channelId: CHANNEL, authorId: BOB, authorName: 'Bob', content: '', attachments: [{ name: 'cake.png', type: 'image/png', size: 10, url: 'https://cdn.example/cake.png' }], createdAt: at(15, 30) }),
        archiveInput({ channelId: CHANNEL, authorId: null, authorName: 'Frigidaire', source: 'bot', content: 'reminder: stretch', createdAt: at(16, 0) }),
        archiveInput({ channelId: 'another-channel', authorId: BOB, authorName: 'Bob', content: 'elsewhere', createdAt: at(17, 0) }),
        archiveInput({ channelId: CHANNEL, authorId: BOB, authorName: 'Bob', content: 'after the post', createdAt: at(19, 1) }),
      ]);
      birthday(ALICE, 9, 25);
      const { writer, inputs } = writerSaying('🎂 hbd');
      const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

      await announcer.run(SEPT25_1500);

      expect(inputs[0].todaysChat).toEqual([
        '09:05 Bob: morning @Alice :kek:',
        '10:00 Alice: [voice message: nobody remembers anything]',
        '11:30 Bob: [file: cake.png]',
        '12:00 Frigidaire (you): reminder: stretch',
      ]);
    } finally {
      setArchiveStoreForTesting(undefined);
    }
  });

  it("keeps only the newest 60 lines of a busy day's chat, and nothing when the archive has none", async () => {
    const archive = new ArchiveStore(':memory:');
    setArchiveStoreForTesting(archive);
    try {
      archive.upsertMessages(
        Array.from({ length: 80 }, (_, i) =>
          archiveInput({ channelId: CHANNEL, content: `line ${i}`, createdAt: Date.UTC(2026, 8, 25, 12, i) }),
        ),
      );
      birthday(ALICE, 9, 25);
      const { writer, inputs } = writerSaying('🎂 hbd');
      const { announcer } = setup({ writer, members: [{ id: ALICE, displayName: 'Alice' }] });

      await announcer.run(SEPT25_1500);

      expect(inputs[0].todaysChat).toHaveLength(60);
      expect(inputs[0].todaysChat?.[0]).toMatch(/: line 20$/);
      expect(inputs[0].todaysChat?.at(-1)).toMatch(/: line 79$/);
    } finally {
      setArchiveStoreForTesting(undefined);
    }

    const empty = writerSaying('🎂 hbd');
    birthday(BOB, 9, 25);
    const { announcer } = setup({ writer: empty.writer, members: [{ id: BOB, displayName: 'Bob' }] });
    await announcer.run(SEPT25_1500);
    expect(empty.inputs[0].todaysChat).toEqual([]);
  });

  it('skips (and settles for the year) someone who left the server', async () => {
    birthday(ALICE, 9, 25);
    const { target, announcer } = setup({ members: [{ id: BOB, displayName: 'Bob' }] });
    expect(await announcer.run(SEPT25_1500)).toBe(0);
    expect(target.sent).toHaveLength(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);
  });

  it('releases the claim when the post fails and retries after a backoff', async () => {
    birthday(ALICE, 9, 25);
    let fail = true;
    const target = createPostableChannel({
      id: CHANNEL,
      sendImpl: async () => {
        if (fail) throw new Error('Service Unavailable');
        return { id: 'ok' };
      },
    });
    const { client } = createSchedulingClient({ [CHANNEL]: target.channel });
    const announcer = new BirthdayAnnouncer({ client, writer: writerSaying('🎂 hbd').writer });

    expect(await announcer.run(SEPT25_1500)).toBe(0);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();

    fail = false;
    // Backoff: the next 30 s tick doesn't retry yet…
    expect(await announcer.run(SEPT25_1500 + 30_000)).toBe(0);
    expect(target.channel.send.calls).toHaveLength(1);
    // …a minute later it does.
    expect(await announcer.run(SEPT25_1500 + 60_000)).toBe(1);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBe(2026);
    // Same nonce both times, so a first send that actually went through is deduplicated by Discord.
    expect(target.channel.send.calls[0][0].nonce).toBe(target.channel.send.calls[1][0].nonce);
  });

  it('backs off when the channel itself is unavailable', async () => {
    birthday(ALICE, 9, 25);
    const { client, channelsFetch } = createSchedulingClient({});
    const announcer = new BirthdayAnnouncer({ client, writer: writerSaying('🎂 hbd').writer });

    await announcer.run(SEPT25_1500);
    await announcer.run(SEPT25_1500 + 30_000);
    expect(channelsFetch.calls).toHaveLength(1);
    expect(getBirthday(ALICE)?.lastAnnouncedYear).toBeNull();
  });
});

describe('finalizeBirthdayMessage / fallbackBirthdayMessage', () => {
  it('strips wrapping quotes, adds the cake and makes sure the person is pinged', () => {
    expect(finalizeBirthdayMessage('"happy birthday you old fart"', ALICE)).toBe(
      `🎂 <@${ALICE}> happy birthday you old fart`,
    );
    expect(finalizeBirthdayMessage(`hbd <@${ALICE}>, finally legal to rent a car`, ALICE)).toBe(
      `🎂 hbd <@${ALICE}>, finally legal to rent a car`,
    );
  });

  it('rejects empty or runaway output', () => {
    expect(finalizeBirthdayMessage('   ', ALICE)).toBeUndefined();
    expect(finalizeBirthdayMessage(null, ALICE)).toBeUndefined();
    expect(finalizeBirthdayMessage('a'.repeat(700), ALICE)).toBeUndefined();
  });

  it('uses the right ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((age) => fallbackBirthdayMessage('u', age))).toEqual([
      '🎂 Happy 1st birthday <@u>!',
      '🎂 Happy 2nd birthday <@u>!',
      '🎂 Happy 3rd birthday <@u>!',
      '🎂 Happy 4th birthday <@u>!',
      '🎂 Happy 11th birthday <@u>!',
      '🎂 Happy 12th birthday <@u>!',
      '🎂 Happy 13th birthday <@u>!',
      '🎂 Happy 21st birthday <@u>!',
      '🎂 Happy 22nd birthday <@u>!',
      '🎂 Happy 23rd birthday <@u>!',
      '🎂 Happy 101st birthday <@u>!',
      '🎂 Happy 111th birthday <@u>!',
    ]);
    expect(fallbackBirthdayMessage('u')).toBe('🎂 Happy birthday <@u>!');
  });
});

describe('createBirthdayWriter', () => {
  function capturingClient(response: { status: number; body: unknown }) {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://openrouter.ai/api/v1',
      maxRetries: 0,
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    });
    return { client, requests };
  }

  const completion = (content: string) => ({
    id: 'gen-1',
    object: 'chat.completion',
    created: 0,
    model: 'test-chat-model',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
  });

  const input: BirthdayMessageInput = {
    userId: ALICE,
    name: 'Alice',
    age: 30,
    memories: ['Alice is a nurse (noted 2mo ago)', 'Alice hates cilantro (noted 1mo ago)'],
    botName: 'Frigidaire',
    today: 'Friday, September 25, 2026',
    todaysChat: ['09:05 Bob: anyone know whose birthday it is'],
  };

  it('asks the chat model with ZDR routing, tags the call as birthday, and finalizes the text', async () => {
    const { client, requests } = capturingClient({
      status: 200,
      body: completion(`<@${ALICE}> 30 and still can't handle cilantro`),
    });
    const writer = createBirthdayWriter({ client, model: 'test-chat-model' });

    expect(await writer(input)).toBe(`🎂 <@${ALICE}> 30 and still can't handle cilantro`);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requests[0].headers.get(FEATURE_HEADER)).toBe('birthday');
    // Low reasoning effort with room for it: the default chat model reasons at 'max' unless told
    // otherwise, and at a 600-token cap that came back empty.
    expect(requests[0].body).toMatchObject({
      model: 'test-chat-model',
      max_tokens: 1500,
      reasoning: { effort: 'low' },
      provider: { zdr: true },
    });
    const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain("It's Alice's birthday today (turning 30)");
    expect(messages[0].content).toContain(`<@${ALICE}>`);
    expect(messages[0].content).toContain('Prefer something long-running about them (a trait, a running joke, old lore)');
    expect(messages[0].content).toContain(
      'anything from the last couple of weeks is recent news, so only bring it up as something that just happened',
    );
    expect(messages[1].content).toMatch(/^Today is Friday, September 25, 2026\.\n/);
    expect(messages[1].content).toContain('What you know about Alice (background only; oldest first');
    expect(messages[1].content).toContain('- Alice hates cilantro (noted 1mo ago)');
    expect(messages[1].content).toMatch(/\n\nThe chat so far today \(background\):\n09:05 Bob: anyone know whose birthday it is$/);
  });

  it('puts the profile first and what was picked up since after it', async () => {
    const { client, requests } = capturingClient({ status: 200, body: completion(`<@${ALICE}> hbd`) });
    const writer = createBirthdayWriter({ client, model: 'test-chat-model' });
    await writer({ ...input, profile: '## Now\nA nurse.', memories: ['broke a toe (noted 2d ago)'] });
    const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain(
      "Your notes on who Alice is (background only):\n## Now\nA nurse.\n\nPicked up since those notes (recent, each with when you first noted it):\n- broke a toe (noted 2d ago)",
    );
  });

  it('returns undefined (template time) on an API error or an empty answer', async () => {
    const failing = capturingClient({ status: 500, body: { error: { message: 'upstream down', code: 500 } } });
    expect(await createBirthdayWriter({ client: failing.client, model: 'm' })(input)).toBeUndefined();

    const empty = capturingClient({ status: 200, body: completion('') });
    expect(await createBirthdayWriter({ client: empty.client, model: 'm' })(input)).toBeUndefined();
  });

  it('returns undefined without an OpenRouter key', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(await createBirthdayWriter()(input)).toBeUndefined();
  });
});
