// Token-sized chunks of a transcript for the memory bootstrap's readers (docs/memory.md "Bootstrap"), and
// the built-in bootstrap's segments. A reader gets one chunk at a time, so a chunk must be big enough to
// hold whole conversations and small enough to avoid context rot: sized by tokens, not by calendar. Each
// boundary goes at the LONGEST quiet gap among the lines that would fill the chunk to 75–100% of its
// target (capture's splitter, which cuts long conversations the same way), so a chunk never ends in the
// middle of a conversation when a quieter point is near (a single day over the target is split at its own
// longest gap the same way), and each chunk opens with the conversation just before it as context.
// Deterministic: the same transcript and options always give the same chunks.
import { splitIntoSegments } from '../../capture/conversation';
import { estimateTokens } from './tokens';
import type { TranscriptLine } from './transcript';

export type ChunkOptions = {
  /** The size a chunk aims for and never passes (unless one line alone is bigger). */
  targetTokens: number;
  /** The lead-in: about this many tokens of the conversation before the chunk (0 = none). */
  leadInTokens: number;
  /** A boundary is only placed once the chunk holds this share of the target (default 0.75). */
  minFill?: number;
};

export const CHUNK_DEFAULTS = { targetTokens: 80_000, leadInTokens: 2_000, minFill: 0.75 } as const;

/** One planned chunk: lines [start, end), with the lead-in lines [leadInStart, start) before it. */
export type ChunkRange = { start: number; end: number; leadInStart: number };

// What a line adds when rendered: its own text and newline, plus the `## day` / `### #channel` headers
// it opens (roughly).
const DAY_HEADER_TOKENS = 8;
const CHANNEL_HEADER_TOKENS = 5;
const TIME_TOKENS = 2;

/** Estimated rendered tokens of each line, headers included, in a transcript read in order. */
export function lineCosts(lines: TranscriptLine[]): number[] {
  return lines.map((line, i) => {
    const previous = lines[i - 1];
    let cost = estimateTokens(line.body) + (line.timed ? TIME_TOKENS : 0) + 1;
    if (!previous || previous.day !== line.day) cost += DAY_HEADER_TOKENS + CHANNEL_HEADER_TOKENS;
    else if (previous.channel !== line.channel) cost += CHANNEL_HEADER_TOKENS;
    return cost;
  });
}

/**
 * Plans the chunks of `lines` (oldest first) with capture's splitter (src/ai/capture/conversation.ts
 * splitIntoSegments), weighing each line in estimated tokens: from each start, take lines while they fit
 * the target, then end the chunk at the longest quiet gap (from a line's last message to the next line)
 * among the boundaries that leave it at least `minFill` full (the latest one on a tie, so chunks stay
 * full). A line bigger than the target is a chunk alone. The lead-in is whole lines within its budget.
 */
export function planChunks(lines: TranscriptLine[], opts: ChunkOptions): ChunkRange[] {
  const costs = lineCosts(lines);
  const items = lines.map((line, index) => ({ at: line.startMs, endAt: line.endMs, chars: costs[index], index }));
  const segments = splitIntoSegments(items, {
    maxChars: Math.max(1, opts.targetTokens),
    minFill: Math.min(1, Math.max(0, opts.minFill ?? CHUNK_DEFAULTS.minFill)),
    leadInChars: 0,
  });
  return segments.map((segment) => {
    const start = segment.items[0].index;
    const end = (segment.items.at(-1)?.index ?? start) + 1;
    return { start, end, leadInStart: leadInStart(costs, start, opts.leadInTokens) };
  });
}

/** Where a lead-in of about `tokens` before line `start` begins (whole lines; `start` itself when 0). */
export function leadInStart(costs: number[], start: number, tokens: number): number {
  let i = start;
  let total = 0;
  while (i > 0 && total + costs[i - 1] <= tokens) {
    total += costs[i - 1];
    i--;
  }
  return i;
}
