// The shared MemoryStore singleton. Lives with the memory code (not in tools.ts) because events, the
// learner, the failure logger and the report channel all need it and none of them care about tools.
import { config } from '../../config';
import { makeDefaultEmbeddingProvider } from './embeddingProvider';
import { MemoryStore } from './memoryStore';

let memoryStore: MemoryStore | undefined;

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    // Structural test hermeticity: inside Vitest, an un-injected getMemoryStore() must never touch
    // the real on-disk DB or the network. Tests that need a specific store inject one via
    // setMemoryStoreForTesting(); anything else gets an isolated, embedder-less in-memory store.
    memoryStore = config.isTest
      ? new MemoryStore(':memory:')
      : new MemoryStore(undefined, { embeddings: makeDefaultEmbeddingProvider() });
  }
  return memoryStore;
}

/** Test-only: lets tests point the shared memory store at an isolated instance (e.g. ':memory:'). */
export function setMemoryStoreForTesting(store: MemoryStore | undefined): void {
  memoryStore = store;
}
