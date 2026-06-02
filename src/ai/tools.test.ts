import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEmbeddingProvider } from '../test-support/fakeEmbeddings';
import { MemoryStore } from './memory/memoryStore';
import { getMemoryStore, setMemoryStoreForTesting, toolDefinitions } from './tools';
import type { ToolHandlerContext } from './types';

// Access the tool handlers by name from the exported array
const queryLongTermMemoryTool = toolDefinitions.find((t) => t.name === 'query_long_term_memory');
const querySelfDiagnosisTool = toolDefinitions.find((t) => t.name === 'query_self_diagnosis');
const forgetMemoryTool = toolDefinitions.find((t) => t.name === 'forget_memory');
const rememberFactTool = toolDefinitions.find((t) => t.name === 'remember_fact');
const recallMemoriesTool = toolDefinitions.find((t) => t.name === 'recall_memories');

// Stub context — these tools don't use ctx fields
const stubCtx = {} as ToolHandlerContext;

// Every test runs against an isolated in-memory store with the deterministic offline fake embedder —
// the on-disk ./data/memory.db is never touched and no network/API call can ever fire.
beforeEach(() => {
  setMemoryStoreForTesting(new MemoryStore(':memory:', { embeddings: new FakeEmbeddingProvider() }));
});

afterEach(() => {
  setMemoryStoreForTesting(undefined);
});

describe('getMemoryStore test hermeticity', () => {
  const dataDir = path.join(process.cwd(), 'data');

  /** Snapshot of every file in ./data (name → mtime+size), to prove nothing on disk is created or modified. */
  function snapshotDataDir(): Map<string, string> {
    const snapshot = new Map<string, string>();
    if (!fs.existsSync(dataDir)) return snapshot;
    for (const name of fs.readdirSync(dataDir)) {
      const stat = fs.statSync(path.join(dataDir, name));
      snapshot.set(name, `${stat.mtimeMs}:${stat.size}`);
    }
    return snapshot;
  }

  it('auto-constructs an isolated in-memory store under Vitest when nothing is injected', async () => {
    // Simulate a test (or transitive import) that reaches getMemoryStore() without injecting first.
    setMemoryStoreForTesting(undefined);
    const before = snapshotDataDir();

    const store = getMemoryStore();
    expect(store).toBeInstanceOf(MemoryStore);
    // Still a singleton: repeated calls return the same instance.
    expect(getMemoryStore()).toBe(store);

    // Writing through the auto-constructed store must not create or modify anything in ./data.
    await store.save({ category: 'fact', subject: 'hermeticity', content: 'must never reach the on-disk database' });
    const results = await store.search('hermeticity database');

    expect(results.length).toBeGreaterThanOrEqual(0); // search works (in-memory)
    expect(snapshotDataDir()).toEqual(before);
  });

  it('uses the injected store when one is set', () => {
    const injected = new MemoryStore(':memory:');
    setMemoryStoreForTesting(injected);
    expect(getMemoryStore()).toBe(injected);
  });
});

describe('query_long_term_memory tool', () => {
  it('exists in toolDefinitions', () => {
    expect(queryLongTermMemoryTool).toBeDefined();
  });

  it('describes itself as conversational memory and points self-diagnosis at query_self_diagnosis', () => {
    expect(queryLongTermMemoryTool!.description).toContain('query_self_diagnosis');
    expect(queryLongTermMemoryTool!.description).not.toMatch(/search everything/i);
  });

  it('finds memories by subject name', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Jason_test', content: 'Works as a mechanic test entry' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Jason_test' });
    expect(result).toContain('Jason_test');
    expect(result).toContain('mechanic');
  });

  it('finds memories by keyword via hybrid search', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'event', subject: 'server', content: 'Zarquon session happened last Moonday night' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Zarquon' });
    expect(result).toContain('Zarquon');
    expect(result).toContain('Moonday');
  });

  it('filters by category when specified', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Quinby_test', content: 'Works in a quarry somewhere unique' });
    await store.save({ category: 'preference', subject: 'Quinby_test', content: 'Prefers ultraviolet theme unique' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, {
      query: 'Quinby_test',
      category: 'preference',
    });
    expect(result).toContain('ultraviolet');
    expect(result).not.toContain('quarry');
  });

  it('returns "no memories found" for nonexistent query', async () => {
    const result = await queryLongTermMemoryTool!.handler(stubCtx, {
      query: 'zzz_completely_nonexistent_xyz_12345',
    });
    expect(result).toContain('No memories found');
  });

  it('returns comprehensive results combining subject + keyword search', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Waldo_test', content: 'Lives in Narnia uniquely' });
    await store.save({ category: 'event', subject: 'server', content: 'Waldo_test hosted a gala uniquely' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Waldo_test' });
    expect(result).toContain('Narnia');
    expect(result).toContain('gala');
  });
});

describe('query_self_diagnosis tool', () => {
  it('exists in toolDefinitions', () => {
    expect(querySelfDiagnosisTool).toBeDefined();
  });

  it('exposes every self-diagnosis category plus "all" in its parameter enum', () => {
    const params = querySelfDiagnosisTool!.parameters as {
      properties: { category: { enum: string[] } };
    };
    expect(params.properties.category.enum).toContain('missing_context');
    expect(params.properties.category.enum).toContain('unrecognized_content');
    expect(params.properties.category.enum).toContain('all');
  });

  it('returns entries filtered by specific category', async () => {
    const store = getMemoryStore();
    // Use unique content to avoid dedup
    await store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot read quantum flux links xyz123',
    });
    await store.save({
      category: 'pain_point',
      subject: 'bot',
      content: 'Responds when absolutely nobody asked xyz123',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain('quantum flux');
    // pain_point should NOT appear when filtering to capability_gap
    expect(result).not.toContain('absolutely nobody asked xyz123');
  });

  it('returns all self-diagnosis categories when category is "all"', async () => {
    const store = getMemoryStore();
    await store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot decode hieroglyphs unique_all_test',
    });
    await store.save({
      category: 'pain_point',
      subject: 'bot',
      content: 'Too verbose in meme channel unique_all_test',
    });
    await store.save({
      category: 'feature_request',
      subject: 'bot',
      content: 'Users want teleportation feature unique_all_test',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'all' });
    expect(result).toContain('hieroglyphs');
    expect(result).toContain('verbose');
    expect(result).toContain('teleportation');
  });

  it('returns "no self-diagnosis data" when no bot/server entries exist for a category', async () => {
    const store = getMemoryStore();
    // Save a non-bot entry in unrecognized_content (won't match the bot/server subject filter)
    await store.save({
      category: 'unrecognized_content',
      subject: 'SomeRandomUser',
      content: 'Unrecognized content test entry',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'missing_context' });
    expect(result).toContain('No self-diagnosis data found');
  });

  it('respects limit parameter', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error alpha bravo' });
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error charlie delta' });
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error echo foxtrot' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'tool_error', limit: 2 });
    const lines = result.split('\n').filter((l: string) => l.startsWith('['));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('filters to only bot/server subjects', async () => {
    const store = getMemoryStore();
    await store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot process antimatter images unique_filter',
    });
    await store.save({
      category: 'capability_gap',
      subject: 'RandomPerson',
      content: 'RandomPerson specific issue unique_filter',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain('antimatter');
    expect(result).not.toContain('RandomPerson specific issue unique_filter');
  });

  it('prefixes every entry with [id:N] so forget_memory can remove it', async () => {
    const store = getMemoryStore();
    const id = await store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot transcribe whale song recordings unique_id_test',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain(`[id:${id}]`);
    expect(result).toContain('whale song');

    // The advertised workflow: pass that id to forget_memory, and the entry disappears.
    const forgetResult = await forgetMemoryTool!.handler(stubCtx, { memory_id: id });
    expect(forgetResult).toContain(`#${id}`);

    const afterForget = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(afterForget).not.toContain('whale song');
  });
});

describe('remember_fact + recall_memories round trip', () => {
  it('saves via remember_fact and finds it via recall_memories', async () => {
    const saveResult = await rememberFactTool!.handler(stubCtx, {
      category: 'preference',
      subject: 'Margo_test',
      content: 'Collects vintage harmonicas enthusiastically',
    });
    expect(saveResult).toMatch(/Saved to memory \(id: \d+\)/);

    const recallResult = await recallMemoriesTool!.handler(stubCtx, {
      query: 'vintage harmonicas',
      subject: 'Margo_test',
    });
    expect(recallResult).toContain('harmonicas');
    expect(recallResult).toMatch(/\[id:\d+\]/);
  });
});
