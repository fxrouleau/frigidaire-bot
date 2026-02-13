import { describe, expect, it } from 'vitest';
import { getMemoryStore, toolDefinitions } from './tools';
import type { ToolHandlerContext } from './types';

// Access the tool handlers by name from the exported array
const queryLongTermMemoryTool = toolDefinitions.find((t) => t.name === 'query_long_term_memory');
const querySelfDiagnosisTool = toolDefinitions.find((t) => t.name === 'query_self_diagnosis');

// Stub context — these tools don't use ctx fields
const stubCtx = {} as ToolHandlerContext;

// Note: The tools module uses a singleton MemoryStore backed by ./data/memory.db.
// Tests accumulate data across runs. Tests are written to be additive and not
// depend on an empty store.

describe('query_long_term_memory tool', () => {
  it('exists in toolDefinitions', () => {
    expect(queryLongTermMemoryTool).toBeDefined();
  });

  it('finds memories by subject name', async () => {
    const store = getMemoryStore();
    store.save({ category: 'fact', subject: 'Jason_test', content: 'Works as a mechanic test entry' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Jason_test' });
    expect(result).toContain('Jason_test');
    expect(result).toContain('mechanic');
  });

  it('finds memories by keyword via FTS', async () => {
    const store = getMemoryStore();
    store.save({ category: 'event', subject: 'server', content: 'Zarquon session happened last Moonday night' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Zarquon' });
    expect(result).toContain('Zarquon');
    expect(result).toContain('Moonday');
  });

  it('filters by category when specified', async () => {
    const store = getMemoryStore();
    store.save({ category: 'fact', subject: 'Quinby_test', content: 'Works in a quarry somewhere unique' });
    store.save({ category: 'preference', subject: 'Quinby_test', content: 'Prefers ultraviolet theme unique' });

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

  it('returns comprehensive results combining subject + FTS', async () => {
    const store = getMemoryStore();
    store.save({ category: 'fact', subject: 'Waldo_test', content: 'Lives in Narnia uniquely' });
    store.save({ category: 'event', subject: 'server', content: 'Waldo_test hosted a gala uniquely' });

    const result = await queryLongTermMemoryTool!.handler(stubCtx, { query: 'Waldo_test' });
    expect(result).toContain('Narnia');
    expect(result).toContain('gala');
  });
});

describe('query_self_diagnosis tool', () => {
  it('exists in toolDefinitions', () => {
    expect(querySelfDiagnosisTool).toBeDefined();
  });

  it('returns entries filtered by specific category', async () => {
    const store = getMemoryStore();
    // Use unique content to avoid dedup
    store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot read quantum flux links xyz123',
    });
    store.save({
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
    store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot decode hieroglyphs unique_all_test',
    });
    store.save({
      category: 'pain_point',
      subject: 'bot',
      content: 'Too verbose in meme channel unique_all_test',
    });
    store.save({
      category: 'feature_request',
      subject: 'bot',
      content: 'Users want teleportation feature unique_all_test',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'all' });
    expect(result).toContain('hieroglyphs');
    expect(result).toContain('verbose');
    expect(result).toContain('teleportation');
  });

  it('returns "no self-diagnosis data" when no bot/server entries exist for unused category', async () => {
    // missing_context is a valid diagnosis category but unlikely to have entries
    // unless explicitly created. Use a fresh unique category check approach:
    // We check that filtering to a category with no bot/server entries returns the empty message.
    const store = getMemoryStore();
    // Save a non-bot entry in unrecognized_content (won't match bot/server filter)
    store.save({
      category: 'unrecognized_content',
      subject: 'SomeRandomUser',
      content: 'Unrecognized content test entry',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'missing_context' });
    expect(result).toContain("No self-diagnosis data found");
  });

  it('respects limit parameter', async () => {
    const store = getMemoryStore();
    store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error alpha bravo' });
    store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error charlie delta' });
    store.save({ category: 'tool_error', subject: 'bot', content: 'Unique limit test error echo foxtrot' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'tool_error', limit: 2 });
    const lines = result.split('\n').filter((l: string) => l.startsWith('['));
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('filters to only bot/server subjects', async () => {
    const store = getMemoryStore();
    store.save({
      category: 'capability_gap',
      subject: 'bot',
      content: 'Cannot process antimatter images unique_filter',
    });
    store.save({
      category: 'capability_gap',
      subject: 'RandomPerson',
      content: 'RandomPerson specific issue unique_filter',
    });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain('antimatter');
    expect(result).not.toContain('RandomPerson specific issue unique_filter');
  });
});
