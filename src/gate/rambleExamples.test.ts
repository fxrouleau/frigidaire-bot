import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchivedMessage } from '../archive';
import { ArchiveStore, setArchiveStoreForTesting } from '../archive/archiveStore';
import { type ArchiveReader, createArchiveRambleExamples, groupRuns } from './rambleExamples';

const GUS = '100000000000000001';
const GUS_SIDE = '200000000000000001';
const KEV = '100000000000000002';
const RAMBLES = '300000000000000001';
const MAIN = '300000000000000002';
const T0 = Date.parse('2026-09-25T18:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const PROSE =
  'and the thing about pigeons is that nobody has ever seen a baby one, which honestly should worry everyone way more than it does right now';

let seq = 0;

function archived(channelId: string, authorId: string | null, content: string, at: number, extra: Partial<ArchivedMessage> = {}) {
  return {
    id: String(1_000_000 + ++seq),
    guildId: 'guild-1',
    channelId,
    parentChannelId: null,
    authorId,
    authorName: authorId === KEV ? 'Kev' : 'Gus',
    source: 'human',
    relayKind: null,
    content,
    extraText: '',
    transcript: null,
    createdAt: at,
    editedAt: null,
    replyToId: null,
    flags: 0,
    hasAudio: false,
    attachments: [],
    embeds: [],
    reactions: [],
    editCount: 0,
    deletedAt: null,
    ...extra,
  } satisfies ArchivedMessage;
}

/** A reader over fixed channel contents that records every read. */
function readerOf(channels: Record<string, ArchivedMessage[]>) {
  const reads: Array<{ channelId: string; startMs: number; endMs: number }> = [];
  const read: ArchiveReader = (channelId, startMs, endMs) => {
    reads.push({ channelId, startMs, endMs });
    // Oldest first, like the archive.
    return (channels[channelId] ?? [])
      .filter((m) => m.createdAt >= startMs && m.createdAt < endMs)
      .sort((a, b) => a.createdAt - b.createdAt);
  };
  return { read, reads };
}

const REQUEST = { userId: GUS, rambleChannelId: RAMBLES, normalChannelId: MAIN };

afterEach(() => {
  vi.unstubAllEnvs();
  setArchiveStoreForTesting(undefined);
});

describe('groupRuns', () => {
  it("joins a member's consecutive messages into one ramble; another author or a 10-minute gap ends it", () => {
    const messages = [
      archived(RAMBLES, GUS, 'ok so', T0),
      archived(RAMBLES, GUS, PROSE, T0 + MIN),
      archived(RAMBLES, KEV, `${PROSE} (kev)`, T0 + 2 * MIN),
      archived(RAMBLES, GUS, `${PROSE} again`, T0 + 3 * MIN),
      archived(RAMBLES, GUS, `${PROSE} much later`, T0 + 20 * MIN),
    ];
    const runs = groupRuns(messages, (id) => id === GUS, (text) => text);
    expect(runs).toEqual([`ok so\n${PROSE}`, `${PROSE} again`, `${PROSE} much later`]);
  });

  it("skips short runs and the bot's own posts", () => {
    const messages = [
      archived(RAMBLES, GUS, 'lol', T0),
      archived(RAMBLES, GUS, PROSE, T0 + 20 * MIN, { source: 'bot' }),
      archived(RAMBLES, null, PROSE, T0 + 21 * MIN),
    ];
    expect(groupRuns(messages, () => true, (text) => text)).toEqual([]);
  });
});

describe('createArchiveRambleExamples', () => {
  it("picks the member's own rambles and some of their normal messages, readable", () => {
    const { read, reads } = readerOf({
      [RAMBLES]: [
        archived(RAMBLES, GUS, `${PROSE} <@${KEV}> <:kekw:123456789012345678>`, T0 - 30 * DAY),
        archived(RAMBLES, KEV, `${PROSE} (kev's)`, T0 - 29 * DAY),
      ],
      [MAIN]: [
        archived(MAIN, GUS, 'down for ranked at 9', T0 - DAY),
        archived(MAIN, GUS, 'ok', T0 - DAY + 1), // too short to show anything
        archived(MAIN, GUS, 'x'.repeat(500), T0 - DAY + 2), // a ramble of its own, not a normal message
        archived(MAIN, KEV, 'kev is not gus', T0 - DAY + 3),
        archived(MAIN, GUS, 'lmao kev you are washed', T0 - DAY + 4),
        archived(MAIN, GUS, 'who has the aux tonight', T0 - DAY + 5),
        archived(MAIN, GUS, 'the new patch is actually fine', T0 - DAY + 6),
      ],
    });
    const examples = createArchiveRambleExamples({
      read,
      now: () => T0,
      random: () => 0,
      resolveName: (id) => (id === KEV ? 'Kev' : undefined),
    })(REQUEST);

    expect(examples.ramblesAreTheirs).toBe(true);
    expect(examples.rambles).toEqual([`${PROSE} @Kev :kekw:`]);
    expect(examples.normal).toEqual([
      'down for ranked at 9',
      'lmao kev you are washed',
      'who has the aux tonight',
      'the new patch is actually fine',
    ]);
    expect(reads.map((r) => [r.channelId, (T0 - r.startMs) / DAY])).toEqual([
      [RAMBLES, 365],
      [MAIN, 14],
    ]);
  });

  it("counts a side account's messages as the member's (LINKED_ACCOUNTS)", () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${GUS_SIDE}:${GUS}`);
    const { read } = readerOf({
      [RAMBLES]: [archived(RAMBLES, GUS_SIDE, PROSE, T0 - DAY)],
      [MAIN]: Array.from({ length: 5 }, (_, i) => archived(MAIN, GUS_SIDE, `normal message number ${i}`, T0 - 1 - i)),
    });
    const examples = createArchiveRambleExamples({ read, now: () => T0, random: () => 0 })(REQUEST);
    expect(examples).toMatchObject({ rambles: [PROSE], ramblesAreTheirs: true });
    expect(examples.normal).toHaveLength(5);
  });

  it("widens the normal-message lookback for a quiet member, and falls back to the channel's other rambles", () => {
    const { read, reads } = readerOf({
      [RAMBLES]: [archived(RAMBLES, KEV, PROSE, T0 - DAY)],
      [MAIN]: [archived(MAIN, GUS, 'only one message lately', T0 - 40 * DAY)],
    });
    const examples = createArchiveRambleExamples({ read, now: () => T0, random: () => 0 })(REQUEST);
    expect(examples).toEqual({
      rambles: [PROSE],
      ramblesAreTheirs: false,
      normal: ['only one message lately'],
    });
    expect(reads.filter((r) => r.channelId === MAIN).map((r) => (T0 - r.startMs) / DAY)).toEqual([14, 60]);
  });

  it('samples at most 4 rambles and 8 normal messages, capped in length', () => {
    const { read } = readerOf({
      [RAMBLES]: Array.from({ length: 10 }, (_, i) => archived(RAMBLES, GUS, `${i} ${PROSE.repeat(10)}`, T0 - i * DAY)),
      [MAIN]: Array.from({ length: 20 }, (_, i) => archived(MAIN, GUS, `${i} ${'y'.repeat(350)}`, T0 - i * MIN)),
    });
    const examples = createArchiveRambleExamples({ read, now: () => T0, random: () => 0.5 })(REQUEST);
    expect(examples.rambles).toHaveLength(4);
    expect(examples.normal).toHaveLength(8);
    for (const ramble of examples.rambles) expect(ramble.length).toBeLessThanOrEqual(700);
    for (const text of examples.normal) expect(text.length).toBeLessThanOrEqual(200);
  });

  it('refreshes once a day, or within the hour while the archive has no rambles yet', () => {
    const clock = { now: T0 };
    const { read, reads } = readerOf({ [RAMBLES]: [archived(RAMBLES, GUS, PROSE, T0 - DAY)] });
    const source = createArchiveRambleExamples({ read, now: () => clock.now, random: () => 0 });
    source(REQUEST);
    clock.now += 23 * 60 * MIN;
    source(REQUEST);
    expect(reads.filter((r) => r.channelId === RAMBLES)).toHaveLength(1);
    clock.now += 2 * 60 * MIN;
    source(REQUEST);
    expect(reads.filter((r) => r.channelId === RAMBLES)).toHaveLength(2);

    const empty = readerOf({});
    const emptySource = createArchiveRambleExamples({ read: empty.read, now: () => clock.now });
    emptySource(REQUEST);
    clock.now += 61 * MIN;
    emptySource(REQUEST);
    expect(empty.reads.filter((r) => r.channelId === RAMBLES)).toHaveLength(2);
  });

  it('reads the real archive by default', () => {
    const store = new ArchiveStore(':memory:');
    setArchiveStoreForTesting(store);
    const { editCount: _e, deletedAt: _d, ...input } = archived(RAMBLES, GUS, PROSE, Date.now() - DAY);
    store.upsertMessage(input);

    const examples = createArchiveRambleExamples({ random: () => 0 })(REQUEST);

    expect(examples.rambles).toEqual([PROSE]);
    store.close();
  });
});
