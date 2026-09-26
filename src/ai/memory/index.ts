// The shared MemoryStore singleton. Lives with the memory code (not in tools.ts) because events, the
// learner, the failure logger and the report channel all need it and none of them care about tools.
import { config } from '../../config';
import { makeDefaultEmbeddingProvider } from './embeddingProvider';
import { MemoryStore } from './memoryStore';
import { NotesStore } from './notes/notesStore';

let memoryStore: MemoryStore | undefined;
// One notes store per memory store (they share memory.db's handle); a test that swaps the memory store
// gets a fresh notes store over it.
const notesStores = new WeakMap<MemoryStore, NotesStore>();

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

/** The notes store (memory v2) over `store`'s database: the shared memory store's by default. */
export function getNotesStore(store: MemoryStore = getMemoryStore()): NotesStore {
  let notes = notesStores.get(store);
  if (!notes) {
    notes = new NotesStore(store);
    notesStores.set(store, notes);
  }
  return notes;
}

/** Test-only: lets tests point the shared memory store at an isolated instance (e.g. ':memory:'). */
export function setMemoryStoreForTesting(store: MemoryStore | undefined): void {
  memoryStore = store;
}

/** Test-only: a notes store with an injected clock over `store` (what getNotesStore(store) returns from then on). */
export function setNotesStoreForTesting(store: MemoryStore, notes: NotesStore): void {
  notesStores.set(store, notes);
}
