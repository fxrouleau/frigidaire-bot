import type { MessageReaction, User } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemoryStore, setMemoryStoreForTesting } from '../ai/tools';
import { MemoryStore } from '../ai/memory/memoryStore';
import * as reactionModule from './reactionTracker';

// `module.exports = {...}` surfaces as the namespace's `default` under Vitest/Vite.
const reactionEvent = (reactionModule as unknown as {
  default: { name: string; execute: (reaction: MessageReaction, user: User) => void };
}).default;

function useCount(id: string): number {
  return getMemoryStore().getEmojiById(id)?.use_count ?? -1;
}

function fakeReaction(emojiId: string | null, name: string | null): MessageReaction {
  return { emoji: { id: emojiId, name } } as unknown as MessageReaction;
}

function fakeUser(bot: boolean): User {
  return { id: 'user-1', bot } as unknown as User;
}

describe('reactionTracker event', () => {
  beforeEach(() => {
    setMemoryStoreForTesting(new MemoryStore(':memory:'));
  });

  afterEach(() => {
    setMemoryStoreForTesting(undefined);
  });

  it('exposes the MessageReactionAdd event name', () => {
    expect(reactionEvent.name).toBe('messageReactionAdd');
  });

  it('increments use_count for a custom emoji reaction', () => {
    getMemoryStore().upsertEmoji({ id: '123456', name: 'pog', animated: false });

    reactionEvent.execute(fakeReaction('123456', 'pog'), fakeUser(false));

    expect(useCount('123456')).toBe(1);
  });

  it('skips Unicode emoji reactions (null emoji id) without error', () => {
    expect(() => reactionEvent.execute(fakeReaction(null, '🔥'), fakeUser(false))).not.toThrow();
    // Nothing was inserted/changed.
    expect(getMemoryStore().getUsableEmojis()).toHaveLength(0);
  });

  it('skips reactions added by a bot user', () => {
    getMemoryStore().upsertEmoji({ id: '777', name: 'botreact', animated: false });

    reactionEvent.execute(fakeReaction('777', 'botreact'), fakeUser(true));

    expect(useCount('777')).toBe(0);
  });

  it('does not throw when the custom emoji is not tracked', () => {
    expect(() => reactionEvent.execute(fakeReaction('888888', 'ghost'), fakeUser(false))).not.toThrow();
    expect(getMemoryStore().getEmojiById('888888')).toBeUndefined();
  });
});
