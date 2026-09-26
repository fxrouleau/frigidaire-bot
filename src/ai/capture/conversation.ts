// Reading a whole conversation for capture (memory v2, docs/memory.md "Capture"). The learner reads a due
// channel from its watermark, paging past Discord's 100-message fetch (up to CAPTURE_LIMITS.maxMessages per
// capture, the rest left for the next one), and splits a conversation too long for one extractor request
// into consecutive segments at its quiet gaps, each opening with a short lead-in (the end of the previous
// segment, shown as context only). Pure functions over fetched messages, so the paging and the split are
// tested without a model.
import type { Collection, Message } from 'discord.js';

export const CAPTURE_LIMITS = {
  /** Messages one capture reads at most; a longer backlog is read by the next capture. */
  maxMessages: 2_000,
  /** Discord's largest list fetch. */
  pageSize: 100,
  /** Characters of rendered transcript per extractor request; a longer conversation is split. */
  segmentMaxChars: 48_000,
  /** A split lands at the longest quiet gap once a segment holds at least this share of its room. */
  minSegmentFill: 0.6,
  /** The lead-in: how much of the previous segment's end each later segment opens with. */
  leadInChars: 2_000,
} as const;

/** What the reader needs from a channel: its message manager's list fetch (discord.js semantics). */
export type MessageFetcher = {
  fetch(options: { limit: number; after?: string; before?: string }): Promise<Collection<string, Message>>;
};

export type UncapturedRead = {
  /** The messages read, oldest first. */
  messages: Message[];
  /** The read stopped at its cap: more uncaptured messages follow the newest one read. */
  capped: boolean;
};

/** Oldest first: by creation time, then by id (equal-length decimal snowflakes compare lexically). */
export function byOldestFirst(a: Message, b: Message): number {
  if (a.createdTimestamp !== b.createdTimestamp) return a.createdTimestamp - b.createdTimestamp;
  if (a.id.length !== b.id.length) return a.id.length - b.id.length;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether two consecutive messages (oldest first) are at least `idleMs` apart anywhere in the list. */
function hasQuietGap(messages: Message[], idleMs: number): boolean {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].createdTimestamp - messages[i - 1].createdTimestamp >= idleMs) return true;
  }
  return false;
}

/**
 * The messages a capture reads, oldest first.
 * - With a watermark: everything after it, a page at a time from the oldest, up to `maxMessages`
 *   (`capped` when a full page was still coming).
 * - Without one (a channel never captured): the newest messages, a page at a time backwards, until the
 *   pages reach a quiet gap of `idleMs` (the start of the last conversation: the caller trims to it), a
 *   short page (the channel's beginning) or `maxMessages`. Older history is the bootstrap's job.
 * A page that brings nothing new ends the read, so a misbehaving fetch can never loop.
 */
export async function readUncaptured(
  fetcher: MessageFetcher,
  watermark: string | null,
  opts: { idleMs: number; maxMessages?: number; pageSize?: number },
): Promise<UncapturedRead> {
  const max = opts.maxMessages ?? CAPTURE_LIMITS.maxMessages;
  const pageSize = opts.pageSize ?? CAPTURE_LIMITS.pageSize;
  const seen = new Set<string>();
  const fresh = (page: Collection<string, Message>) =>
    [...page.values()].filter((m) => !seen.has(m.id) && seen.add(m.id)).sort(byOldestFirst);

  if (watermark) {
    const messages: Message[] = [];
    let after = watermark;
    for (;;) {
      const page = await fetcher.fetch({ limit: pageSize, after });
      const added = fresh(page);
      messages.push(...added);
      const exhausted = page.size < pageSize || added.length === 0;
      if (messages.length >= max) {
        // The oldest `max`: the next capture continues from the newest of them.
        return { messages: messages.slice(0, max), capped: messages.length > max || !exhausted };
      }
      if (exhausted) return { messages, capped: false };
      after = added[added.length - 1].id;
    }
  }

  let messages: Message[] = [];
  let before: string | undefined;
  while (messages.length < max) {
    const page = await fetcher.fetch(before ? { limit: pageSize, before } : { limit: pageSize });
    const added = fresh(page);
    messages = [...added, ...messages];
    if (page.size < pageSize || added.length === 0 || hasQuietGap(messages, opts.idleMs)) break;
    before = added[0].id;
  }
  return { messages: messages.slice(-max), capped: false };
}

/**
 * Where the last conversation starts: the index of the first item after the last gap of at least `idleMs`
 * between consecutive items (oldest first), or 0 when there is none.
 */
export function conversationStartIndex(items: readonly { at: number }[], idleMs: number): number {
  for (let i = items.length - 1; i > 0; i--) {
    if (items[i].at - items[i - 1].at >= idleMs) return i;
  }
  return 0;
}

/** A transcript entry the splitter can weigh: when it was posted, and its rendered size. */
export type SizedItem = { at: number; chars: number };

export type Segment<T> = {
  /** The end of the previous segment, shown as context only (empty for the first segment). */
  leadIn: T[];
  /** What this request extracts from. */
  items: T[];
};

/**
 * Splits a conversation (oldest first) into consecutive segments of at most `maxChars` (a single item
 * larger than that gets a segment of its own). Each cut lands at the longest pause between two items
 * among the positions where the segment already holds `minFill` of its room (ties: the later one), so a
 * long conversation is split between its exchanges, never mid-reply when a pause exists. Every segment
 * after the first opens with the items just before it, up to `leadInChars` (at least one). Deterministic.
 */
export function splitIntoSegments<T extends SizedItem>(
  items: readonly T[],
  opts: { maxChars?: number; leadInChars?: number; minFill?: number } = {},
): Segment<T>[] {
  const maxChars = opts.maxChars ?? CAPTURE_LIMITS.segmentMaxChars;
  const leadInChars = opts.leadInChars ?? CAPTURE_LIMITS.leadInChars;
  const minChars = maxChars * (opts.minFill ?? CAPTURE_LIMITS.minSegmentFill);
  const segments: Segment<T>[] = [];
  let start = 0;
  while (start < items.length) {
    // The furthest end that fits (at least one item), with the running sizes.
    let end = start;
    let size = 0;
    const sizeBefore: number[] = [];
    while (end < items.length && (end === start || size + items[end].chars <= maxChars)) {
      size += items[end].chars;
      end++;
      sizeBefore[end] = size;
    }
    let cut = end;
    if (end < items.length) {
      let bestGap = Number.NEGATIVE_INFINITY;
      for (let k = start + 1; k <= end; k++) {
        if (sizeBefore[k] < minChars && k !== end) continue;
        const gap = items[k].at - items[k - 1].at;
        if (gap >= bestGap) {
          bestGap = gap;
          cut = k;
        }
      }
    }
    segments.push({ leadIn: leadInBefore(items, start, leadInChars), items: items.slice(start, cut) });
    start = cut;
  }
  return segments;
}

/** The items just before `start`, oldest first, up to `maxChars` (at least one when there is one). */
function leadInBefore<T extends SizedItem>(items: readonly T[], start: number, maxChars: number): T[] {
  const leadIn: T[] = [];
  let size = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (leadIn.length > 0 && size + items[i].chars > maxChars) break;
    size += items[i].chars;
    leadIn.unshift(items[i]);
  }
  return leadIn;
}
