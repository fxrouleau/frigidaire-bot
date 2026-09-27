import { describe, expect, it } from 'vitest';
import { lineCosts, leadInStart, planChunks } from './chunks';
import type { TranscriptLine } from './transcript';

const MIN = 60_000;

/** A line of ~`tokens` estimated tokens starting at minute `at`. */
function line(at: number, tokens = 10, day = '2024-03-01', channel = '#general'): TranscriptLine {
  const body = `Remi: ${'abcdefg '.repeat(Math.max(0, Math.round((tokens - 4) * 3.5 / 8)))}`.trimEnd();
  return {
    startMs: at * MIN,
    endMs: at * MIN,
    day,
    channel,
    author: 'Remi',
    time: '21:40',
    body,
    timed: false,
    payloadChars: body.length,
    payloadTokens: tokens,
    messageIds: [String(at)],
  };
}

/** Lines at these minutes (all one day and channel). */
function at(minutes: number[], tokens = 10): TranscriptLine[] {
  return minutes.map((m) => line(m, tokens));
}

describe('planChunks', () => {
  it('ends each chunk at the longest quiet gap that keeps it at least 75% full', () => {
    // 20 lines of equal size; the target fits 10. Quiet gaps: 30 min before line 8, 90 min before line 9.
    const minutes = [0, 1, 2, 3, 4, 5, 6, 7, 37, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137];
    const lines = at(minutes);
    const cost = lineCosts(lines)[1];
    const chunks = planChunks(lines, { targetTokens: cost * 10 + 5, leadInTokens: 0 });
    expect(chunks[0]).toEqual({ start: 0, end: 9, leadInStart: 0 });
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 9],
      [9, 19],
      [19, 20],
    ]);
  });

  it('never ends a chunk before 75% of the target, even at a longer gap', () => {
    // The longest gap is right after line 1: too early for a boundary.
    const lines = at([0, 500, 501, 502, 503, 504, 505, 506, 507, 530, 531, 532]);
    const cost = lineCosts(lines)[1];
    const chunks = planChunks(lines, { targetTokens: cost * 10 + 5, leadInTokens: 0 });
    expect(chunks[0].end).toBe(9);
  });

  it('keeps every chunk within the target, and a line bigger than the target alone', () => {
    const lines = [...at([0, 1, 2]), line(3, 5_000), ...at([4, 5, 6])];
    const chunks = planChunks(lines, { targetTokens: 100, leadInTokens: 0 });
    const costs = lineCosts(lines);
    for (const chunk of chunks) {
      const tokens = costs.slice(chunk.start, chunk.end).reduce((a, b) => a + b, 0);
      if (chunk.end - chunk.start > 1) expect(tokens).toBeLessThanOrEqual(100);
    }
    expect(chunks.some((c) => c.start === 3 && c.end === 4)).toBe(true);
    expect(chunks.at(-1)?.end).toBe(lines.length);
  });

  it('covers every line exactly once, in order, deterministically', () => {
    const lines = at(Array.from({ length: 500 }, (_, i) => i * 3 + (i % 17 === 0 ? 240 : 0) + Math.floor(i / 17) * 240));
    const plan = planChunks(lines, { targetTokens: 400, leadInTokens: 60 });
    let next = 0;
    for (const chunk of plan) {
      expect(chunk.start).toBe(next);
      expect(chunk.end).toBeGreaterThan(chunk.start);
      next = chunk.end;
    }
    expect(next).toBe(lines.length);
    expect(planChunks(lines, { targetTokens: 400, leadInTokens: 60 })).toEqual(plan);
  });

  it('gives each chunk after the first a lead-in of whole lines within its budget', () => {
    const lines = at(Array.from({ length: 60 }, (_, i) => i * 10));
    const costs = lineCosts(lines);
    const plan = planChunks(lines, { targetTokens: costs[1] * 20, leadInTokens: costs[1] * 3 });
    expect(plan[0].leadInStart).toBe(0);
    for (const chunk of plan.slice(1)) {
      expect(chunk.start - chunk.leadInStart).toBe(3);
    }
    expect(leadInStart(costs, 10, 0)).toBe(10);
  });
});
