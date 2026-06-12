import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationPersistence } from './conversationPersistence';
import { type ConversationState, ConversationStore } from './conversationStore';

const TIMEOUT = 60_000;

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    providerId: 'fake',
    entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    timestamp: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ConversationStore with persistence', () => {
  it('works without persistence (pure in-memory, no throw)', () => {
    const store = new ConversationStore(TIMEOUT);
    store.set('c', makeState());
    expect(store.get('c')).toBeDefined();
    store.close(); // no-op when there is no persistence
  });

  describe('restore on construction', () => {
    let persistence: ConversationPersistence;

    beforeEach(() => {
      persistence = new ConversationPersistence(':memory:');
    });

    it('seeds non-expired persisted state and drops expired rows', () => {
      const now = Date.now();
      persistence.save('fresh', makeState({ timestamp: now }));
      persistence.save('expired', makeState({ timestamp: now - 2 * TIMEOUT }));

      const store = new ConversationStore(TIMEOUT, persistence);

      expect(store.get('fresh')).toBeDefined();
      expect(store.get('expired')).toBeUndefined();

      store.close();
    });

    it('writes through on set() so persistence sees the new state', () => {
      const store = new ConversationStore(TIMEOUT, persistence);
      const state = makeState({ providerId: 'openrouter', injectedMemoryIds: [7] });

      store.set('chan', state);

      const loaded = persistence.loadAll(TIMEOUT);
      expect(loaded).toHaveLength(1);
      const [channelId, restored] = loaded[0];
      expect(channelId).toBe('chan');
      expect(restored.providerId).toBe('openrouter');
      expect(restored.injectedMemoryIds).toEqual([7]);

      store.close();
    });

    it('pruneExpired prunes both the in-memory Map and persistence', () => {
      const t0 = 50_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(t0);

      const store = new ConversationStore(TIMEOUT, persistence);
      store.set('c', makeState({ timestamp: t0 }));

      vi.setSystemTime(t0 + TIMEOUT + 1);
      store.pruneExpired();

      // @ts-expect-error accessing private map for verification
      expect(store.store.size).toBe(0);
      expect(persistence.loadAll(TIMEOUT)).toHaveLength(0);

      store.close();
    });
  });
});
