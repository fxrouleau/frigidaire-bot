import type { MessageReaction, MessageReactionEventDetails, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMemoryStore, setMemoryStoreForTesting } from '../ai/memory';
import { MemoryStore } from '../ai/memory/memoryStore';
import { logger } from '../logger';
import reactionEvent from './reactionTracker';

function useCount(id: string): number {
  return getMemoryStore().getEmojiById(id)?.use_count ?? -1;
}

function fakeReaction(emojiId: string | null, name: string | null): MessageReaction {
  return { emoji: { id: emojiId, name } } as unknown as MessageReaction;
}

// A reaction on a message sent before the last restart: the message is partial and so is the reaction
// (count is null), but the emoji comes straight from the gateway event.
function fakePartialReaction(emojiId: string, name: string): PartialMessageReaction {
  return {
    partial: true,
    count: null,
    emoji: { id: emojiId, name },
    message: { id: 'old-message', partial: true },
  } as unknown as PartialMessageReaction;
}

function fakeUser(bot: boolean): User {
  return { id: 'user-1', bot } as unknown as User;
}

function fakePartialUser(fetchImpl: () => Promise<User>): PartialUser & { fetchCalls: number } {
  const user = {
    id: 'user-2',
    partial: true,
    bot: null,
    fetchCalls: 0,
    fetch: async () => {
      user.fetchCalls += 1;
      return fetchImpl();
    },
  };
  return user as unknown as PartialUser & { fetchCalls: number };
}

const DETAILS = { type: 0, burst: false } as unknown as MessageReactionEventDetails;

describe('reactionTracker event', () => {
  beforeEach(() => {
    setMemoryStoreForTesting(new MemoryStore(':memory:'));
  });

  afterEach(() => {
    setMemoryStoreForTesting(undefined);
    vi.restoreAllMocks();
  });

  it('exposes the MessageReactionAdd event name', () => {
    expect(reactionEvent.name).toBe('messageReactionAdd');
  });

  it('increments use_count for a custom emoji reaction', async () => {
    getMemoryStore().upsertEmoji({ id: '123456', name: 'pog', animated: false });

    await reactionEvent.execute(fakeReaction('123456', 'pog'), fakeUser(false), DETAILS);

    expect(useCount('123456')).toBe(1);
  });

  it('skips Unicode emoji reactions (null emoji id) without error', async () => {
    await expect(reactionEvent.execute(fakeReaction(null, '🔥'), fakeUser(false), DETAILS)).resolves.toBeUndefined();
    // Nothing was inserted/changed.
    expect(getMemoryStore().getUsableEmojis()).toHaveLength(0);
  });

  it('skips reactions added by a bot user', async () => {
    getMemoryStore().upsertEmoji({ id: '777', name: 'botreact', animated: false });

    await reactionEvent.execute(fakeReaction('777', 'botreact'), fakeUser(true), DETAILS);

    expect(useCount('777')).toBe(0);
  });

  it('does not throw when the custom emoji is not tracked', async () => {
    await expect(
      reactionEvent.execute(fakeReaction('888888', 'ghost'), fakeUser(false), DETAILS),
    ).resolves.toBeUndefined();
    expect(getMemoryStore().getEmojiById('888888')).toBeUndefined();
  });

  it('counts a partial reaction on a message from before the last restart', async () => {
    getMemoryStore().upsertEmoji({ id: '424242', name: 'KEKW', animated: false });

    await reactionEvent.execute(fakePartialReaction('424242', 'KEKW'), fakeUser(false), DETAILS);

    expect(useCount('424242')).toBe(1);
  });

  it('fetches a partial user once to learn whether it is a bot', async () => {
    getMemoryStore().upsertEmoji({ id: '31337', name: 'monkaS', animated: false });

    const human = fakePartialUser(async () => fakeUser(false));
    await reactionEvent.execute(fakePartialReaction('31337', 'monkaS'), human, DETAILS);
    expect(human.fetchCalls).toBe(1);
    expect(useCount('31337')).toBe(1);

    const bot = fakePartialUser(async () => fakeUser(true));
    await reactionEvent.execute(fakePartialReaction('31337', 'monkaS'), bot, DETAILS);
    expect(useCount('31337')).toBe(1);
  });

  it('skips (and logs) when a partial user cannot be fetched', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    getMemoryStore().upsertEmoji({ id: '9001', name: 'Sadge', animated: false });

    const unknown = fakePartialUser(async () => {
      throw new Error('Unknown User');
    });
    await expect(reactionEvent.execute(fakeReaction('9001', 'Sadge'), unknown, DETAILS)).resolves.toBeUndefined();

    expect(useCount('9001')).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not fetch partial user user-2'), expect.any(Error));
  });
});
