import type { Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemoryStore, setMemoryStoreForTesting } from '../ai/tools';
import { MemoryStore } from '../ai/memory/memoryStore';
import { createFakeMessage } from '../test-support/fakeDiscord';
import * as emojiUsageModule from './emojiUsageTracker';

// `module.exports = {...}` surfaces as the namespace's `default` under Vitest/Vite.
const emojiUsageEvent = (emojiUsageModule as unknown as {
  default: { name: string; execute: (message: Message) => void };
}).default;

function useCount(id: string): number {
  return getMemoryStore().getEmojiById(id)?.use_count ?? -1;
}

describe('emojiUsageTracker event', () => {
  beforeEach(() => {
    setMemoryStoreForTesting(new MemoryStore(':memory:'));
  });

  afterEach(() => {
    setMemoryStoreForTesting(undefined);
  });

  it('exposes the MessageCreate event name', () => {
    expect(emojiUsageEvent.name).toBe('messageCreate');
  });

  it('increments use_count for a static custom emoji in the message', () => {
    getMemoryStore().upsertEmoji({ id: '123456', name: 'pog', animated: false });
    const fake = createFakeMessage({ content: 'nice <:pog:123456> moment' });

    emojiUsageEvent.execute(fake.message);

    expect(useCount('123456')).toBe(1);
  });

  it('tracks animated emoji syntax', () => {
    getMemoryStore().upsertEmoji({ id: '789', name: 'dance', animated: true });
    const fake = createFakeMessage({ content: 'lets <a:dance:789> all night' });

    emojiUsageEvent.execute(fake.message);

    expect(useCount('789')).toBe(1);
  });

  it('increments each distinct emoji in a single message', () => {
    const store = getMemoryStore();
    store.upsertEmoji({ id: '111', name: 'one', animated: false });
    store.upsertEmoji({ id: '222', name: 'two', animated: false });
    const fake = createFakeMessage({ content: '<:one:111> and <:two:222>' });

    emojiUsageEvent.execute(fake.message);

    expect(useCount('111')).toBe(1);
    expect(useCount('222')).toBe(1);
  });

  it('counts every occurrence when the same emoji repeats in one message', () => {
    getMemoryStore().upsertEmoji({ id: '333', name: 'spam', animated: false });
    const fake = createFakeMessage({ content: '<:spam:333> <:spam:333> <:spam:333>' });

    emojiUsageEvent.execute(fake.message);

    // The handler dedups ids into a Map but accumulates a per-id count, then
    // increments by that count — so three occurrences yield use_count 3.
    expect(useCount('333')).toBe(3);
  });

  it('does not track emojis in bot-authored messages', () => {
    getMemoryStore().upsertEmoji({ id: '444', name: 'bot', animated: false });
    const fake = createFakeMessage({ authorIsBot: true, content: '<:bot:444>' });

    emojiUsageEvent.execute(fake.message);

    expect(useCount('444')).toBe(0);
  });

  it('does not track emojis in webhook messages', () => {
    getMemoryStore().upsertEmoji({ id: '555', name: 'hook', animated: false });
    const fake = createFakeMessage({ webhookId: 'wh-1', content: '<:hook:555>' });

    emojiUsageEvent.execute(fake.message);

    expect(useCount('555')).toBe(0);
  });

  it('does nothing for a message with no custom emojis', () => {
    getMemoryStore().upsertEmoji({ id: '666', name: 'idle', animated: false });
    const fake = createFakeMessage({ content: 'just plain text 🙂 with a unicode emoji' });

    expect(() => emojiUsageEvent.execute(fake.message)).not.toThrow();
    expect(useCount('666')).toBe(0);
  });

  it('does not throw when the emoji is not in the store (no active row)', () => {
    const fake = createFakeMessage({ content: 'unknown <:ghost:999999>' });
    expect(() => emojiUsageEvent.execute(fake.message)).not.toThrow();
    // No row was ever inserted, so nothing to read.
    expect(getMemoryStore().getEmojiById('999999')).toBeUndefined();
  });
});
