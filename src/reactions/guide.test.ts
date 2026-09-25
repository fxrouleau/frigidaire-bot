import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmojiRow } from '../ai/memory/memoryStore';
import type { ReactionProfile, ReactionProfileEntry } from '../archive';
import { ArchiveStore, setArchiveStoreForTesting } from '../archive/archiveStore';
import { archiveInput } from '../test-support/fakeArchive';
import {
  GUIDE_EMOJIS,
  ReactionGuideCache,
  buildGuideFromArchive,
  buildReactionGuide,
  mergeProfiles,
  readableEmojiText,
} from './guide';

const MAIN = '100000000000000001';
const CLIPS = '100000000000000002';
const KEKW = '300000000000000001';
const GONE = '300000000000000009';
const T0 = Date.UTC(2026, 0, 15, 17, 0);

function emojiRow(id: string, name: string, caption: string | null = null): EmojiRow {
  return {
    id,
    name,
    animated: 0,
    caption,
    captioned_at: null,
    active: 1,
    use_count: 0,
    last_used_at: null,
  };
}

function entry(overrides: Partial<ReactionProfileEntry> & { key: string }): ReactionProfileEntry {
  return {
    id: null,
    name: overrides.key,
    animated: false,
    uses: 1,
    messages: 1,
    lastUsedAt: T0,
    samples: [],
    ...overrides,
  };
}

function sample(snippet: string, count: number, createdAt = T0) {
  return { messageId: `m-${snippet}`, channelId: MAIN, guildId: 'g', authorId: 'a', authorName: 'A', createdAt, count, snippet };
}

describe('mergeProfiles', () => {
  it('adds counts per emoji across channels and keeps the best examples', () => {
    const a: ReactionProfile = {
      messages: 100,
      reactedMessages: 10,
      baseRate: 0.1,
      emojis: [entry({ key: '😂', uses: 5, messages: 4, samples: [sample('ok joke', 1)] })],
    };
    const b: ReactionProfile = {
      messages: 50,
      reactedMessages: 20,
      baseRate: 0.4,
      emojis: [
        entry({ key: '😂', uses: 7, messages: 5, samples: [sample('great joke', 6), sample('(no text)', 9)] }),
        entry({ key: KEKW, id: KEKW, name: 'KEKW', uses: 20, messages: 9 }),
      ],
    };
    const merged = mergeProfiles([a, b]);
    expect(merged.messages).toBe(150);
    expect(merged.reactedMessages).toBe(30);
    expect(merged.baseRate).toBeCloseTo(0.2);
    expect(merged.emojis.map((e) => [e.key, e.uses, e.messages])).toEqual([
      [KEKW, 20, 9],
      ['😂', 12, 9],
    ]);
    // Text before textless, then most reacted.
    expect(merged.emojis[1].samples.map((s) => s.snippet)).toEqual(['great joke', 'ok joke', '(no text)']);
  });

  it('is empty for no profiles', () => {
    expect(mergeProfiles([])).toEqual({ messages: 0, reactedMessages: 0, baseRate: 0, emojis: [] });
  });
});

describe('buildReactionGuide', () => {
  const profile: ReactionProfile = {
    messages: 1000,
    reactedMessages: 123,
    baseRate: 0.123,
    emojis: [
      entry({ key: GONE, id: GONE, name: 'trolle', uses: 99 }),
      entry({
        key: KEKW,
        id: KEKW,
        name: 'OLDNAME',
        uses: 40,
        samples: [sample('he parallel parked into a "hydrant"', 5), sample('(no text)', 2), sample('<:KEKW:300000000000000001> lmao', 1)],
      }),
      entry({ key: '💀', uses: 12, samples: [sample(`${'x'.repeat(150)}`, 3)] }),
    ],
  };

  it('keeps unicode and live server emojis (under their current name) and drops removed ones', () => {
    const guide = buildReactionGuide(profile, [emojiRow(KEKW, 'KEKW')], T0);
    expect(guide.emojis.map((e) => e.label)).toEqual([':KEKW:', '💀']);
    expect(guide.emojis[0]).toMatchObject({ id: KEKW, name: 'KEKW', uses: 40 });
    expect(guide.reactedMessages).toBe(123);
    expect(guide.builtAt).toBe(T0);
  });

  it('renders the base rate, captions, and quoted, readable, clipped examples', () => {
    const guide = buildReactionGuide(profile, [emojiRow(KEKW, 'KEKW', 'laughing face; for big laughs')], T0);
    expect(guide.text).toContain('About 12% of member posts here get any reaction at all (123 of 1000).');
    expect(guide.text).toContain(
      `- :KEKW: (40×) [laughing face; for big laughs] — "he parallel parked into a 'hydrant'" · ":KEKW: lmao"`,
    );
    expect(guide.text).not.toContain('(no text)');
    expect(guide.text).not.toContain('trolle');
    const skull = guide.text.split('\n').find((line) => line.startsWith('- 💀'));
    expect(skull?.length).toBeLessThan(130);
    expect(skull).toContain('…"');
  });

  it(`caps the guide at ${GUIDE_EMOJIS} emojis`, () => {
    const many: ReactionProfile = {
      messages: 10,
      reactedMessages: 10,
      baseRate: 1,
      emojis: Array.from({ length: 40 }, (_, i) => entry({ key: `e${i}`, uses: 40 - i })),
    };
    expect(buildReactionGuide(many, [], T0).emojis).toHaveLength(GUIDE_EMOJIS);
  });

  it('is empty text for an empty profile', () => {
    expect(buildReactionGuide({ messages: 0, reactedMessages: 0, baseRate: 0, emojis: [] }, [], T0).text).toBe('');
  });
});

describe('readableEmojiText', () => {
  it('turns custom emoji tokens into :name:', () => {
    expect(readableEmojiText('lol <:KEKW:300000000000000001> <a:party:300000000000000002>')).toBe('lol :KEKW: :party:');
  });
});

describe('buildGuideFromArchive', () => {
  let store: ArchiveStore;

  beforeEach(() => {
    store = new ArchiveStore(':memory:');
    setArchiveStoreForTesting(store);
  });

  afterEach(() => {
    setArchiveStoreForTesting(undefined);
    store.close();
    vi.unstubAllEnvs();
  });

  it('merges the reaction profiles of every watched channel from the archive', () => {
    store.upsertMessages([
      archiveInput({
        channelId: MAIN,
        createdAt: T0,
        content: 'I got stuck in the revolving door again',
        reactions: [{ id: KEKW, name: 'KEKW', count: 3 }],
      }),
      archiveInput({
        channelId: CLIPS,
        createdAt: T0 + 1000,
        content: 'look at this clip',
        reactions: [
          { id: KEKW, name: 'KEKW', count: 2 },
          { id: null, name: '😂', count: 2, me: true },
        ],
      }),
      archiveInput({ channelId: MAIN, createdAt: T0 + 2000, content: 'plain message' }),
      // A channel that isn't watched does not count.
      archiveInput({
        channelId: '100000000000000003',
        createdAt: T0 + 3000,
        content: 'elsewhere',
        reactions: [{ id: null, name: '🔥', count: 5 }],
      }),
    ]);
    const guide = buildGuideFromArchive([MAIN, CLIPS], [emojiRow(KEKW, 'KEKW')], T0);
    expect(guide.messages).toBe(3);
    expect(guide.reactedMessages).toBe(2);
    // The bot's own reaction is not the group's.
    expect(guide.emojis.map((e) => [e.label, e.uses])).toEqual([
      [':KEKW:', 5],
      ['😂', 1],
    ]);
    expect(guide.text).toContain('revolving door');
  });

  it('is empty when the archive is disabled', () => {
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    expect(buildGuideFromArchive([MAIN], [], T0).reactedMessages).toBe(0);
  });
});

describe('ReactionGuideCache', () => {
  it('rebuilds daily once ready and hourly while still learning', () => {
    let now = T0;
    let reacted = 10;
    const build = vi.fn(() => ({ ...buildReactionGuide(mergeProfiles([]), [], now), reactedMessages: reacted }));
    const cache = new ReactionGuideCache({ build, now: () => now });

    expect(cache.get(200).reactedMessages).toBe(10);
    now += 30 * 60 * 1000;
    cache.get(200);
    expect(build).toHaveBeenCalledTimes(1);
    now += 31 * 60 * 1000; // past the hour: learning guides refresh hourly
    reacted = 500;
    expect(cache.get(200).reactedMessages).toBe(500);
    expect(build).toHaveBeenCalledTimes(2);
    now += 23 * 60 * 60 * 1000;
    cache.get(200);
    expect(build).toHaveBeenCalledTimes(2);
    now += 61 * 60 * 1000;
    cache.get(200);
    expect(build).toHaveBeenCalledTimes(3);
    cache.invalidate();
    cache.get(200);
    expect(build).toHaveBeenCalledTimes(4);
  });
});
