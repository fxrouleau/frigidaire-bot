import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger';
import { MemoryStore } from './memoryStore';
import { runStartupMemoryMaintenance } from './startupMaintenance';

// Fake ids only.
const MAIN = '100000000000000001';
const SIDE = '100000000000000002';

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(':memory:');
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runStartupMemoryMaintenance', () => {
  it('stamps before compacting, so rows it links to a member dedup on the same start', async () => {
    store.upsertIdentity(MAIN, 'Jason', 'cigalefourmi');
    await store.save({ category: 'fact', subject: 'Jason', subject_user_id: MAIN, content: 'Works nights at the depot' });
    // Filed under the handle, without an id: only the stamp can tell it's the same person.
    await store.save({ category: 'fact', subject: 'cigalefourmi', content: 'Works nights at the depot' });

    const result = runStartupMemoryMaintenance(store);

    expect(result).toMatchObject({ stamped: 1, removed: 1 });
    expect(store.getAllActive()).toHaveLength(1);
  });

  it("dedups a side account's rows with the main account's (LINKED_ACCOUNTS)", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    store.upsertIdentity(MAIN, 'Tony');
    store.upsertIdentity(SIDE, 'Ptoughneigh');
    await store.save({ category: 'fact', subject: 'Tony', subject_user_id: MAIN, content: 'Owns a black lab named Moose' });
    await store.save({ category: 'fact', subject: 'Ptoughneigh', subject_user_id: SIDE, content: 'Owns a black lab named Moose' });

    const result = runStartupMemoryMaintenance(store);

    expect(result).toMatchObject({ relinked: 1, removed: 1 });
    expect(store.getAllActive().map((m) => m.subject_user_id)).toEqual([MAIN]);
  });

  it('still compacts when the stamp fails', () => {
    vi.spyOn(store, 'stampSubjectUserIds').mockImplementation(() => {
      throw new Error('boom');
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const compact = vi.spyOn(store, 'compact');

    runStartupMemoryMaintenance(store);

    expect(compact).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Memory subject-id stamp on startup failed:', expect.any(Error));
  });
});
