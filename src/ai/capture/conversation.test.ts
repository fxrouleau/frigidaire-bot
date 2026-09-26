import { Collection, type Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import {
  CAPTURE_LIMITS,
  conversationStartIndex,
  type MessageFetcher,
  readUncaptured,
  type SizedItem,
  splitIntoSegments,
} from './conversation';

const MIN = 60_000;
const BASE = new Date('2026-09-01T14:00:00Z').getTime();
// Placeholder snowflakes: the fake channel log orders and filters by numeric id, like Discord.
const idAt = (i: number) => String(300_000_000_000_000_000n + BigInt(i));

/** Message i, posted at `minutes` after BASE (default: one a minute). */
function msg(i: number, minutes = i): Message {
  return createFakeMessage({
    messageId: idAt(i),
    createdAt: new Date(BASE + minutes * MIN),
    authorId: '100000000000000001',
    content: `message ${i}`,
  }).message;
}

/** A channel whose message manager serves `log` with Discord's list-fetch semantics, and records each fetch. */
function channelServing(log: Message[]): { fetcher: MessageFetcher; fetches: unknown[][] } {
  const fake = createFakeMessage({ channelId: 'chan-1', channelMessages: log });
  const channel = fake.message.channel as unknown as { messages: MessageFetcher };
  return { fetcher: channel.messages, fetches: fake.recorders.messagesFetch.calls };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

describe('readUncaptured', () => {
  it('pages forward from the watermark past the 100-message fetch, oldest first', async () => {
    const log = range(0, 260).map((i) => msg(i));
    const { fetcher, fetches } = channelServing(log);

    const read = await readUncaptured(fetcher, idAt(9), { idleMs: 20 * MIN });

    expect(read.capped).toBe(false);
    expect(read.messages.map((m) => m.id)).toEqual(range(10, 260).map(idAt));
    expect(fetches).toEqual([
      [{ limit: 100, after: idAt(9) }],
      [{ limit: 100, after: idAt(109) }],
      [{ limit: 100, after: idAt(209) }],
    ]);
  });

  it('stops at its cap and says more is waiting', async () => {
    const log = range(0, 450).map((i) => msg(i));
    const { fetcher, fetches } = channelServing(log);

    const read = await readUncaptured(fetcher, idAt(0), { idleMs: 20 * MIN, maxMessages: 300 });

    expect(read.capped).toBe(true);
    expect(read.messages.map((m) => m.id)).toEqual(range(1, 301).map(idAt));
    expect(fetches).toHaveLength(3);
  });

  it('reads the default cap of 2,000 messages at most', async () => {
    const log = range(0, 2_150).map((i) => msg(i));
    const { fetcher, fetches } = channelServing(log);

    const read = await readUncaptured(fetcher, idAt(0), { idleMs: 20 * MIN });

    expect(CAPTURE_LIMITS.maxMessages).toBe(2_000);
    expect([read.messages.length, read.capped, fetches.length]).toEqual([2_000, true, 20]);
  });

  it('keeps exactly the oldest messages up to a cap that is not a whole number of pages', async () => {
    const log = range(0, 400).map((i) => msg(i));
    const { fetcher } = channelServing(log);

    const read = await readUncaptured(fetcher, idAt(0), { idleMs: 20 * MIN, maxMessages: 150 });
    expect([read.messages.length, read.messages.at(-1)?.id, read.capped]).toEqual([150, idAt(150), true]);

    // A cap reached on the channel's last, short page: nothing more is waiting.
    const short = channelServing(range(0, 151).map((i) => msg(i)));
    const exact = await readUncaptured(short.fetcher, idAt(0), { idleMs: 20 * MIN, maxMessages: 150 });
    expect([exact.messages.length, exact.capped]).toEqual([150, false]);
  });

  it('returns nothing when nothing is newer than the watermark', async () => {
    const { fetcher } = channelServing(range(0, 5).map((i) => msg(i)));
    expect(await readUncaptured(fetcher, idAt(4), { idleMs: 20 * MIN })).toEqual({ messages: [], capped: false });
  });

  it('never loops on a fetch that ignores its cursor', async () => {
    const page = range(0, 100).map((i) => msg(i));
    let calls = 0;
    const fetcher: MessageFetcher = {
      fetch: async () => {
        calls++;
        return new Collection(page.map((m) => [m.id, m]));
      },
    };

    const read = await readUncaptured(fetcher, idAt(0), { idleMs: 20 * MIN });

    expect([read.messages.length, read.capped, calls]).toEqual([100, false, 2]);
  });

  it('without a watermark, pages back from the newest until it reaches a quiet gap', async () => {
    // An old conversation, a 3-hour pause, then a 150-message one.
    const log = [...range(0, 50).map((i) => msg(i)), ...range(50, 200).map((i) => msg(i, i + 180))];
    const { fetcher, fetches } = channelServing(log);

    const read = await readUncaptured(fetcher, null, { idleMs: 20 * MIN });

    expect(fetches).toEqual([[{ limit: 100 }], [{ limit: 100, before: idAt(100) }]]);
    expect(read.messages.map((m) => m.id)).toEqual(range(0, 200).map(idAt));
    expect(read.capped).toBe(false);
  });

  it('without a watermark, stops at the channel start', async () => {
    const { fetcher, fetches } = channelServing(range(0, 30).map((i) => msg(i)));
    const read = await readUncaptured(fetcher, null, { idleMs: 20 * MIN });
    expect([read.messages.length, fetches.length]).toEqual([30, 1]);
  });
});

describe('conversationStartIndex', () => {
  it('finds the first item after the last quiet gap', () => {
    const at = (minutes: number[]) => minutes.map((m) => ({ at: m * MIN }));
    expect(conversationStartIndex(at([0, 1, 2]), 20 * MIN)).toBe(0);
    expect(conversationStartIndex(at([0, 1, 40, 41, 90, 91]), 20 * MIN)).toBe(4);
    expect(conversationStartIndex(at([0, 20]), 20 * MIN)).toBe(1);
    expect(conversationStartIndex([], 20 * MIN)).toBe(0);
  });
});

describe('splitIntoSegments', () => {
  type Item = SizedItem & { n: number };
  /** Items of `chars` each; `gaps[k]` minutes before item k (default 1). */
  function items(count: number, chars: number, gaps: Record<number, number> = {}): Item[] {
    let at = 0;
    return range(0, count).map((n) => {
      if (n > 0) at += (gaps[n] ?? 1) * MIN;
      return { n, at, chars };
    });
  }
  const ns = (list: Item[]) => list.map((i) => i.n);

  it('keeps a conversation that fits in one segment, without a lead-in', () => {
    const segments = splitIntoSegments(items(10, 100), { maxChars: 1_000 });
    expect(segments).toHaveLength(1);
    expect(ns(segments[0].items)).toEqual(range(0, 10));
    expect(segments[0].leadIn).toEqual([]);
    expect(splitIntoSegments([], { maxChars: 1_000 })).toEqual([]);
  });

  it('cuts at the longest pause once a segment is full enough', () => {
    // 20 items of 100 chars, room for 10 per segment; pauses before items 4 (15 min) and 8 (5 min).
    const segments = splitIntoSegments(items(20, 100, { 4: 15, 8: 5 }), { maxChars: 1_000, minFill: 0.6 });
    // Item 4's pause is too early (the segment would hold 4 of its 10 items); item 8's is the longest after 6.
    expect(segments.map((s) => ns(s.items))).toEqual([range(0, 8), range(8, 18), range(18, 20)]);
  });

  it('prefers the later of two equal pauses, and fills the room when there is no pause', () => {
    const even = splitIntoSegments(items(15, 100), { maxChars: 1_000 });
    expect(even.map((s) => ns(s.items))).toEqual([range(0, 10), range(10, 15)]);
  });

  it('opens every later segment with the end of the previous one, up to the lead-in size', () => {
    const segments = splitIntoSegments(items(25, 100), { maxChars: 1_000, leadInChars: 250 });
    expect(segments.map((s) => ns(s.leadIn))).toEqual([[], [8, 9], [18, 19]]);
    // At least one item even when it is larger than the lead-in.
    const big = splitIntoSegments(items(4, 600), { maxChars: 1_000, leadInChars: 250 });
    expect(big.map((s) => ns(s.leadIn))).toEqual([[], [0], [1], [2]]);
  });

  it('gives an item larger than the room a segment of its own', () => {
    const list = [...items(2, 100), { n: 2, at: 3 * MIN, chars: 5_000 }, { n: 3, at: 4 * MIN, chars: 100 }];
    const segments = splitIntoSegments(list, { maxChars: 1_000 });
    expect(segments.map((s) => ns(s.items))).toEqual([[0, 1], [2], [3]]);
  });

  it('covers every item exactly once, in order', () => {
    const gaps = Object.fromEntries(range(1, 300).map((k) => [k, (k * 7919) % 13]));
    const list = items(300, 150, gaps).map((item) => ({ ...item, chars: 50 + ((item.n * 31) % 400) }));
    const segments = splitIntoSegments(list, { maxChars: 5_000 });
    expect(segments.flatMap((s) => ns(s.items))).toEqual(range(0, 300));
    for (const segment of segments) {
      expect(segment.items.reduce((sum, i) => sum + i.chars, 0)).toBeLessThanOrEqual(5_000);
    }
  });
});
