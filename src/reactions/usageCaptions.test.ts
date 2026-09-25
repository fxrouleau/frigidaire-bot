import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsagePhraseInput } from '../ai/emojiCaptioner';
import { MemoryStore } from '../ai/memory/memoryStore';
import { ArchiveStore } from '../archive/archiveStore';
import { BotDb } from '../storage/botDb';
import { archiveInput, snowflake } from '../test-support/fakeArchive';
import {
  MAX_PER_RUN,
  MIN_USES,
  type UsageCaptionDeps,
  WEEK_MS,
  lastRunAt,
  runUsageRecaption,
  runUsageRecaptionIfDue,
} from './usageCaptions';

const SAJ = '300000000000000001';
const SMODGE = '300000000000000002';
const RARE = '300000000000000003';
const NOCAP = '300000000000000004';
const T0 = Date.UTC(2026, 8, 25, 16, 0);

let memory: MemoryStore;
let archive: ArchiveStore;
let botDb: BotDb;
let clock: { now: number };
let describe_: ReturnType<typeof vi.fn<(input: UsagePhraseInput) => Promise<string | undefined>>>;
let deps: UsageCaptionDeps;
let seq = 0;

function addEmoji(id: string, name: string, caption?: string): void {
  memory.upsertEmoji({ id, name, animated: false });
  if (caption) memory.setEmojiCaption(id, caption);
}

/** `n` member messages typing the emoji. */
function typedUses(id: string, name: string, n: number): void {
  archive.upsertMessages(
    Array.from({ length: n }, () => {
      const createdAt = T0 - 1000 * ++seq;
      return archiveInput({
        id: snowflake(createdAt),
        createdAt,
        content: `the week keeps getting worse, number ${seq} <:${name}:${id}>`,
      });
    }),
  );
}

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  archive = new ArchiveStore(':memory:');
  botDb = new BotDb(':memory:');
  clock = { now: T0 };
  describe_ = vi.fn(async (input: UsagePhraseInput) => `for how the group uses ${input.name}`);
  deps = {
    memory: () => memory,
    archive: () => archive,
    botDb: () => botDb,
    describe: describe_,
    now: () => clock.now,
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});

  addEmoji(SAJ, 'SAJ', 'crying cat; for sadness, pleading');
  addEmoji(SMODGE, 'smodge', 'squinting face; for deep thought');
  addEmoji(RARE, 'rare', 'a rare thing; for rarity');
  addEmoji(NOCAP, 'nocap');
  typedUses(SAJ, 'SAJ', 8);
  typedUses(SMODGE, 'smodge', MIN_USES);
  typedUses(RARE, 'rare', MIN_USES - 1);
  typedUses(NOCAP, 'nocap', 10);
});

afterEach(() => {
  memory.close();
  archive.close();
  vi.restoreAllMocks();
});

describe('runUsageRecaption', () => {
  it('rewrites the meaning half of captioned emojis with enough uses, keeping the visual half', async () => {
    const result = await runUsageRecaption({}, deps);
    expect(result).toEqual({ eligible: 2, due: 2, updated: 2, failed: 0, aborted: false });
    expect(memory.getEmojiById(SAJ)?.caption).toBe('crying cat; for how the group uses SAJ');
    expect(memory.getEmojiById(SMODGE)?.caption).toBe('squinting face; for how the group uses smodge');
    // Too few uses, or no first-pass caption to keep the visual half of: untouched.
    expect(memory.getEmojiById(RARE)?.caption).toBe('a rare thing; for rarity');
    expect(memory.getEmojiById(NOCAP)?.caption).toBeNull();

    // Most used first; the model sees the real uses and the current caption.
    const first = describe_.mock.calls[0][0];
    expect(first).toMatchObject({ id: SAJ, name: 'SAJ', animated: false, caption: 'crying cat; for sadness, pleading' });
    expect(first.uses).toHaveLength(8);
    expect(first.uses[0]).toMatch(/^- in a message: "the week keeps getting worse, number \d+ :SAJ:"$/);
    expect(lastRunAt(deps)).toBe(T0);
  });

  it('re-grounds only what changed: a replaced caption, or uses grown by half', async () => {
    await runUsageRecaption({}, deps);
    describe_.mockClear();

    expect(await runUsageRecaption({}, deps)).toMatchObject({ eligible: 2, due: 0, updated: 0 });
    expect(describe_).not.toHaveBeenCalled();

    // A rename re-captions from the image (emojiSync): the new caption gets grounded again.
    memory.setEmojiCaption(SMODGE, 'squinting face, renamed; for deep thought');
    typedUses(SAJ, 'SAJ', 9); // 8 → 17 uses: not yet +50% AND +10
    expect(await runUsageRecaption({}, deps)).toMatchObject({ due: 1, updated: 1 });
    expect(memory.getEmojiById(SMODGE)?.caption).toBe('squinting face, renamed; for how the group uses smodge');

    typedUses(SAJ, 'SAJ', 1); // 18 uses: +10 and more than 1.5× the 8 it was grounded on
    expect(await runUsageRecaption({}, deps)).toMatchObject({ due: 1, updated: 1 });
    expect(describe_.mock.calls.map((c) => c[0].name)).toEqual(['smodge', 'SAJ']);
  });

  it('re-grounds everything when forced', async () => {
    await runUsageRecaption({}, deps);
    expect(await runUsageRecaption({ force: true }, deps)).toMatchObject({ due: 2, updated: 2 });
  });

  it('keeps going past a failure, and gives up (watermark untouched) after repeated ones', async () => {
    describe_.mockResolvedValueOnce(undefined);
    expect(await runUsageRecaption({}, deps)).toMatchObject({ updated: 1, failed: 1, aborted: false });
    expect(memory.getEmojiById(SAJ)?.caption).toBe('crying cat; for sadness, pleading');

    const failing = { ...deps, describe: vi.fn(async () => undefined), now: () => T0 + 1 };
    for (let i = 0; i < 5; i++) addEmoji(`30000000000000010${i}`, `e${i}`, `thing ${i}; for stuff`);
    for (let i = 0; i < 5; i++) typedUses(`30000000000000010${i}`, `e${i}`, MIN_USES);
    const result = await runUsageRecaption({}, failing);
    expect(result).toMatchObject({ failed: 3, aborted: true });
    expect(failing.describe).toHaveBeenCalledTimes(3);
    expect(lastRunAt(deps)).toBe(T0);
  });

  it(`does at most ${MAX_PER_RUN} per weekly run, all of them when forced`, async () => {
    for (let i = 0; i < MAX_PER_RUN + 5; i++) {
      const id = String(300000000000001000n + BigInt(i));
      addEmoji(id, `bulk${i}`, `bulk ${i}; for bulk`);
      typedUses(id, `bulk${i}`, MIN_USES);
    }
    expect(await runUsageRecaption({}, deps)).toMatchObject({ due: MAX_PER_RUN + 7, updated: MAX_PER_RUN });
    expect(await runUsageRecaption({}, deps)).toMatchObject({ due: 7, updated: 7 });
  });

  it('never throws', async () => {
    const broken = {
      ...deps,
      memory: () => {
        throw new Error('db gone');
      },
    };
    expect(await runUsageRecaption({}, broken)).toMatchObject({ aborted: true, updated: 0 });
  });
});

describe('runUsageRecaptionIfDue', () => {
  it('runs weekly, or whenever forced', async () => {
    expect(await runUsageRecaptionIfDue({}, deps)).toMatchObject({ updated: 2 });
    clock.now = T0 + WEEK_MS - 1;
    expect(await runUsageRecaptionIfDue({}, deps)).toBeUndefined();
    expect(await runUsageRecaptionIfDue({ force: true }, deps)).toMatchObject({ updated: 2 });
    clock.now = T0 + 2 * WEEK_MS;
    expect(await runUsageRecaptionIfDue({}, deps)).toMatchObject({ due: 0 });
  });
});
