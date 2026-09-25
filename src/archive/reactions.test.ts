import type { MessageReaction, MessageReactionEventDetails, User } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import reactionAddEvent from '../events/archiveReactionAdd';
import reactionRemoveEvent from '../events/archiveReactionRemove';
import reactionRemoveAllEvent from '../events/archiveReactionRemoveAll';
import reactionRemoveEmojiEvent from '../events/archiveReactionRemoveEmoji';
import { BOT_USER_ID, archivableMessage, archiveInput, snowflake } from '../test-support/fakeArchive';
import { ArchiveStore, type ArchivedReaction, setArchiveStoreForTesting } from './archiveStore';
import { toArchiveInput } from './ingest';
import {
  type ReactionEventLike,
  applyReactionDelta,
  archiveReactionChange,
  archiveReactionEmojiCleared,
  archiveReactionsCleared,
  getReactionProfile,
  reactionsOf,
} from './reactions';

const KEKW = '300000000000000001';
const PARTY = '300000000000000002';
const CHANNEL = '100000000000000001';
const THREAD = '100000000000000003';
const OTHER_CHANNEL = '100000000000000002';
const T0 = Date.UTC(2026, 0, 15, 17, 0);
const MEMBER = { id: '200000000000000005' };
const BOT = { id: BOT_USER_ID };

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

type Snapshot = { id?: string | null; name: string; count: number; me?: boolean; animated?: boolean };

function reactionEvent(
  messageId: string,
  emoji: { id: string | null; name: string },
  opts: { partial: boolean; cache?: Snapshot[] },
): ReactionEventLike {
  const cache = new Map(
    (opts.cache ?? []).map((r) => [
      r.id ?? r.name,
      { emoji: { id: r.id ?? null, name: r.name, animated: r.animated ?? false }, count: r.count, me: r.me ?? false },
    ]),
  );
  return {
    emoji,
    message: { id: messageId, partial: opts.partial, reactions: { cache } },
    client: { user: { id: BOT_USER_ID } },
  };
}

describe('reactionsOf / ingest', () => {
  it("converts a message's reaction cache (custom, animated, unicode, the bot's own)", () => {
    const message = archivableMessage({
      content: 'lmao',
      reactions: [
        { id: KEKW, name: 'kekw', count: 3, me: true },
        { id: PARTY, name: 'party', animated: true, count: 1 },
        { name: '😂', count: 2 },
        { name: '💀', count: 0 },
      ],
    });
    expect(reactionsOf(message)).toEqual([
      { id: KEKW, name: 'kekw', count: 3, me: true },
      { id: PARTY, name: 'party', animated: true, count: 1 },
      { id: null, name: '😂', count: 2 },
    ]);
    // Ingest (live and backfill) carries them into the archive row.
    const input = toArchiveInput(message);
    expect(input?.reactions).toHaveLength(3);
  });

  it('handles a message without a reaction manager', () => {
    expect(reactionsOf({ reactions: null })).toEqual([]);
  });
});

describe('applyReactionDelta', () => {
  it('adds, increments, decrements and drops at zero', () => {
    const emoji = { id: null, name: '🔥' };
    let list = applyReactionDelta([], emoji, 1, false);
    expect(list).toEqual([{ id: null, name: '🔥', count: 1 }]);
    list = applyReactionDelta(list, emoji, 1, false);
    expect(list).toEqual([{ id: null, name: '🔥', count: 2 }]);
    list = applyReactionDelta(list, emoji, -1, false);
    list = applyReactionDelta(list, emoji, -1, false);
    expect(list).toEqual([]);
    expect(applyReactionDelta([], emoji, -1, false)).toEqual([]);
  });

  it("tracks the bot's own reaction and never counts it twice", () => {
    const emoji = { id: KEKW, name: 'kekw', animated: false };
    let list = applyReactionDelta([{ id: KEKW, name: 'kekw', count: 2 }], emoji, 1, true);
    expect(list).toEqual([{ id: KEKW, name: 'kekw', count: 3, me: true }]);
    expect(applyReactionDelta(list, emoji, 1, true)).toBe(list);
    list = applyReactionDelta(list, emoji, 1, false);
    expect(list).toEqual([{ id: KEKW, name: 'kekw', count: 4, me: true }]);
    list = applyReactionDelta(list, emoji, -1, true);
    expect(list).toEqual([{ id: KEKW, name: 'kekw', count: 3 }]);
  });

  it('ignores an emoji without id or name', () => {
    const list = [{ id: null, name: '🔥', count: 1 }];
    expect(applyReactionDelta(list, { id: null, name: null }, 1, false)).toBe(list);
  });
});

describe('reaction events', () => {
  function seed(reactions: ArchivedReaction[] = [{ id: null, name: '😂', count: 2 }]) {
    const input = archiveInput({ content: 'joke', reactions });
    store.upsertMessage(input);
    return input.id;
  }

  it('copies the full reaction cache of a cached (non-partial) message', () => {
    const id = seed();
    const changed = archiveReactionChange(
      reactionEvent(id, { id: KEKW, name: 'kekw' }, {
        partial: false,
        cache: [
          { name: '😂', count: 2 },
          { id: KEKW, name: 'kekw', count: 1 },
        ],
      }),
      MEMBER,
      1,
    );
    expect(changed).toBe(true);
    expect(store.getReactions(id)).toEqual([
      { id: KEKW, name: 'kekw', count: 1 },
      { id: null, name: '😂', count: 2 },
    ]);
  });

  it("applies a delta for a partial (uncached) message, whose cache counts can't be trusted", () => {
    const id = seed();
    // discord.js' partial message only knows this one reaction, with a made-up count.
    const add = reactionEvent(id, { id: null, name: '😂' }, { partial: true, cache: [{ name: '😂', count: 1 }] });
    archiveReactionChange(add, MEMBER, 1);
    expect(store.getReactions(id)).toEqual([{ id: null, name: '😂', count: 3 }]);
    archiveReactionChange(add, BOT, 1);
    expect(store.getReactions(id)).toEqual([{ id: null, name: '😂', count: 4, me: true }]);
    archiveReactionChange(add, BOT, -1);
    archiveReactionChange(add, MEMBER, -1);
    expect(store.getReactions(id)).toEqual([{ id: null, name: '😂', count: 2 }]);
  });

  it('leaves messages the archive does not hold (or deleted ones) alone', () => {
    const unknown = snowflake(T0, 9);
    expect(archiveReactionChange(reactionEvent(unknown, { id: null, name: '😂' }, { partial: true }), MEMBER, 1)).toBe(
      false,
    );
    expect(store.getMessage(unknown)).toBeUndefined();

    const id = seed();
    store.markDeleted([id], T0 + 1);
    expect(archiveReactionChange(reactionEvent(id, { id: null, name: '😂' }, { partial: true }), MEMBER, 1)).toBe(false);
    expect(store.getReactions(id)).toBeUndefined();
  });

  it('clears all reactions, or one emoji', () => {
    const id = seed([
      { id: null, name: '😂', count: 2 },
      { id: KEKW, name: 'kekw', count: 5 },
    ]);
    expect(archiveReactionEmojiCleared(reactionEvent(id, { id: KEKW, name: 'kekw' }, { partial: true }))).toBe(true);
    expect(store.getReactions(id)).toEqual([{ id: null, name: '😂', count: 2 }]);
    expect(archiveReactionsCleared({ id })).toBe(true);
    expect(store.getReactions(id)).toEqual([]);
    expect(store.getMessage(id)?.reactions).toEqual([]);
  });

  it('does nothing when the archive is disabled', () => {
    const id = seed();
    vi.stubEnv('ARCHIVE_ENABLED', 'false');
    expect(archiveReactionsCleared({ id })).toBe(false);
    expect(store.getReactions(id)).toHaveLength(1);
  });

  it('never throws on a storage failure', () => {
    const id = seed();
    store.close();
    expect(archiveReactionChange(reactionEvent(id, { id: null, name: '😂' }, { partial: true }), MEMBER, 1)).toBe(false);
    expect(archiveReactionsCleared({ id })).toBe(false);
    expect(archiveReactionEmojiCleared(reactionEvent(id, { id: null, name: '😂' }, { partial: true }))).toBe(false);
    store = new ArchiveStore(':memory:'); // afterEach closes it
  });

  it('wires the four discord.js reaction events', () => {
    const id = seed();
    const details = { type: 0, burst: false } as unknown as MessageReactionEventDetails;
    const reaction = reactionEvent(id, { id: null, name: '🔥' }, { partial: true }) as unknown as MessageReaction;
    const user = MEMBER as unknown as User;

    expect(reactionAddEvent.name).toBe('messageReactionAdd');
    reactionAddEvent.execute(reaction, user, details);
    expect(store.getReactions(id)).toContainEqual({ id: null, name: '🔥', count: 1 });

    expect(reactionRemoveEvent.name).toBe('messageReactionRemove');
    reactionRemoveEvent.execute(reaction, user, details);
    expect(store.getReactions(id)).not.toContainEqual(expect.objectContaining({ name: '🔥' }));

    expect(reactionRemoveEmojiEvent.name).toBe('messageReactionRemoveEmoji');
    reactionRemoveEmojiEvent.execute(
      reactionEvent(id, { id: null, name: '😂' }, { partial: true }) as unknown as MessageReaction,
    );
    expect(store.getReactions(id)).toEqual([]);

    store.updateReactions(id, [{ id: null, name: '👍', count: 1 }]);
    expect(reactionRemoveAllEvent.name).toBe('messageReactionRemoveAll');
    reactionRemoveAllEvent.execute(
      archivableMessage({ id }) as unknown as Parameters<typeof reactionRemoveAllEvent.execute>[0],
      new Map() as unknown as Parameters<typeof reactionRemoveAllEvent.execute>[1],
    );
    expect(store.getReactions(id)).toEqual([]);
  });
});

describe('getReactionProfile', () => {
  function msg(i: number, overrides: Parameters<typeof archiveInput>[0] = {}) {
    return archiveInput({ id: snowflake(T0 + i * 1000, i), createdAt: T0 + i * 1000, ...overrides });
  }

  function seedProfile() {
    store.upsertMessages([
      msg(1, {
        content: 'first joke',
        reactions: [
          { id: KEKW, name: 'kekw', count: 3, me: true },
          { id: null, name: '😂', count: 1 },
        ],
      }),
      msg(2, { content: 'second joke', reactions: [{ id: KEKW, name: 'kekw', count: 1 }] }),
      msg(3, {
        content: '',
        attachments: [{ name: 'meme.png', type: 'image/png', size: 1, url: 'https://cdn/meme.png' }],
        reactions: [{ id: KEKW, name: 'kekw', count: 5 }],
      }),
      // Only the bot reacted: not a member reaction, so the message does not count as reacted.
      msg(4, { content: 'bot liked this', reactions: [{ id: PARTY, name: 'party', count: 1, me: true }] }),
      msg(5, { content: 'no reactions' }),
      // The bot's own messages and deleted messages are outside the profile.
      msg(6, { content: 'bot reply', source: 'bot', authorId: BOT_USER_ID, reactions: [{ id: null, name: '👍', count: 4 }] }),
      msg(7, { content: 'deleted', reactions: [{ id: null, name: '🗑️', count: 4 }] }),
      // A thread under the channel, and another channel.
      msg(8, {
        content: 'thread joke',
        channelId: THREAD,
        parentChannelId: CHANNEL,
        reactions: [{ id: null, name: '😂', count: 2 }],
      }),
      msg(9, { content: 'elsewhere', channelId: OTHER_CHANNEL, reactions: [{ id: null, name: '😂', count: 1 }] }),
      // The custom emoji was renamed later: the profile reports its latest name.
      msg(10, { content: 'renamed', reactions: [{ id: KEKW, name: 'kekwait', count: 1 }] }),
    ]);
    store.markDeleted([msg(7).id], T0 + DAY_MS);
  }
  const DAY_MS = 86_400_000;

  it('summarizes uses, messages, samples and the base rate, without the bot', () => {
    seedProfile();
    const profile = getReactionProfile({}, store);
    // Member messages: 1,2,3,4,5,8,9,10 (8); reacted by members: 1,2,3,8,9,10 (6).
    expect(profile.messages).toBe(8);
    expect(profile.reactedMessages).toBe(6);
    expect(profile.baseRate).toBeCloseTo(6 / 8);

    expect(profile.emojis.map((e) => [e.key, e.name, e.uses, e.messages])).toEqual([
      [KEKW, 'kekwait', 2 + 1 + 5 + 1, 4],
      ['😂', '😂', 1 + 2 + 1, 3],
    ]);
    const kekw = profile.emojis[0];
    expect(kekw.id).toBe(KEKW);
    expect(kekw.lastUsedAt).toBe(T0 + 10_000);
    // Text first (by count, then newest); the image-only message after them.
    expect(kekw.samples.map((s) => [s.snippet, s.count])).toEqual([
      ['first joke', 2],
      ['renamed', 1],
      ['second joke', 1],
    ]);
    expect(kekw.samples[0]).toMatchObject({ authorName: 'Remi', channelId: CHANNEL });
  });

  it('falls back to what an image-only sample carried', () => {
    seedProfile();
    const profile = getReactionProfile({ samplesPerEmoji: 4 }, store);
    expect(profile.emojis[0].samples.map((s) => s.snippet)).toContain('[attached: meme.png]');
  });

  it('scopes by channel (threads included) and by time', () => {
    seedProfile();
    const inChannel = getReactionProfile({ channelId: CHANNEL }, store);
    expect(inChannel.messages).toBe(7);
    expect(inChannel.emojis.find((e) => e.key === '😂')?.uses).toBe(3);

    const recent = getReactionProfile({ sinceMs: T0 + 8000 }, store);
    expect(recent.messages).toBe(3);
    expect(recent.emojis.map((e) => e.key).sort()).toEqual([KEKW, '😂'].sort());

    const limited = getReactionProfile({ limit: 1, samplesPerEmoji: 0 }, store);
    expect(limited.emojis).toHaveLength(1);
    expect(limited.emojis[0].samples).toEqual([]);
  });

  it('is empty (not an error) for an empty archive, a disabled archive, or a broken store', () => {
    expect(getReactionProfile({}, store)).toEqual({ messages: 0, reactedMessages: 0, baseRate: 0, emojis: [] });
    seedProfile();
    // Default: the shared store.
    expect(getReactionProfile().messages).toBe(8);
    vi.stubEnv('ARCHIVE_ENABLED', 'no');
    expect(getReactionProfile({}, store).messages).toBe(0);
    vi.unstubAllEnvs();
    const broken = new ArchiveStore(':memory:');
    broken.close();
    expect(getReactionProfile({}, broken).emojis).toEqual([]);
  });
});
