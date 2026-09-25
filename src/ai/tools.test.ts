import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeMessage, type FakeMessageOptions } from '../test-support/fakeDiscord';
import { FakeEmbeddingProvider } from '../test-support/fakeEmbeddings';
import { getMemoryStore, setMemoryStoreForTesting } from './memory';
import { MemoryStore } from './memory/memoryStore';
import { toolDefinitions } from './tools';
import type { ToolHandlerContext } from './types';

// Access the tool handlers by name from the exported array
const querySelfDiagnosisTool = toolDefinitions.find((t) => t.name === 'query_self_diagnosis');
const forgetMemoryTool = toolDefinitions.find((t) => t.name === 'forget_memory');
const rememberFactTool = toolDefinitions.find((t) => t.name === 'remember_fact');
const recallMemoriesTool = toolDefinitions.find((t) => t.name === 'recall_memories');
const getEmojiTool = toolDefinitions.find((t) => t.name === 'get_emoji');

// Stub context — these tools don't use ctx fields
const stubCtx = {} as ToolHandlerContext;

// Every test runs against an isolated in-memory store with the deterministic offline fake embedder —
// the on-disk ./data/memory.db is never touched and no network/API call can ever fire.
// Thresholds are PINNED (not defaulted) so these tests stay decoupled from the prod defaults, which
// will be re-tuned after live calibration — same discipline as memoryStore.test.ts's makeSemanticStore().
// The keyword-search tests here have fake cosines of ~0.378 (Zarquon) and ~0.408 (Waldo), so the
// pinned 0.3 gate keeps them passing on their own merits regardless of where the prod default lands.
beforeEach(() => {
  setMemoryStoreForTesting(
    new MemoryStore(':memory:', {
      embeddings: new FakeEmbeddingProvider(),
      relevanceThreshold: 0.3,
      dedupThreshold: 0.88,
    }),
  );
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

    // The auto-constructed store is embedder-less under Vitest (VITEST guard) → ungated FTS search:
    // 'hermeticity' matches the subject column and 'database' matches content → exactly one hit.
    // This proves the in-memory store actually works end-to-end, not just that it exists.
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('hermeticity');
    expect(snapshotDataDir()).toEqual(before);
  });

  it('uses the injected store when one is set', () => {
    const injected = new MemoryStore(':memory:');
    setMemoryStoreForTesting(injected);
    expect(getMemoryStore()).toBe(injected);
  });
});

describe('tool surface', () => {
  it('exposes exactly one memory search tool (query_long_term_memory was merged into recall_memories)', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('recall_memories');
    expect(names).not.toContain('query_long_term_memory');
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('recall_memories tool', () => {
  it('exists in toolDefinitions', () => {
    expect(recallMemoriesTool).toBeDefined();
  });

  it('describes itself as conversational memory and points self-diagnosis at query_self_diagnosis', () => {
    expect(recallMemoriesTool!.description).toContain('query_self_diagnosis');
    expect(recallMemoriesTool!.description).not.toMatch(/search everything/i);
  });

  it('finds memories by subject name given as the query', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Jason_test', content: 'Works as a mechanic test entry' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'Jason_test' });
    expect(result).toContain('Jason_test');
    expect(result).toContain('mechanic');
  });

  it('finds memories by keyword via hybrid search', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'event', subject: 'server', content: 'Zarquon session happened last Moonday night' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'Zarquon' });
    expect(result).toContain('Zarquon');
    expect(result).toContain('Moonday');
  });

  it('filters by category when specified', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Quinby_test', content: 'Works in a quarry somewhere unique' });
    await store.save({ category: 'preference', subject: 'Quinby_test', content: 'Prefers ultraviolet theme unique' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'Quinby_test', category: 'preference' });
    expect(result).toContain('ultraviolet');
    expect(result).not.toContain('quarry');
  });

  it('filters by an explicit subject', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'preference', subject: 'Margo_test', content: 'Collects vintage harmonicas enthusiastically' });
    await store.save({ category: 'preference', subject: 'Other_test', content: 'Collects vintage harmonicas too' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'vintage harmonicas', subject: 'Margo_test' });
    const firstLine = result.split('\n')[1];
    expect(firstLine).toContain('Margo_test');
  });

  it('returns "no memories found" for a nonexistent query', async () => {
    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'zzz_completely_nonexistent_xyz_12345' });
    expect(result).toContain('No memories found');
  });

  it('returns comprehensive results combining subject + keyword search', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Waldo_test', content: 'Lives in Narnia uniquely' });
    await store.save({ category: 'event', subject: 'server', content: 'Waldo_test hosted a gala uniquely' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'Waldo_test' });
    expect(result).toContain('Narnia');
    expect(result).toContain('gala');
  });

  it('prefixes every result with [id:N] so forget_memory can act on it', async () => {
    const store = getMemoryStore();
    const id = await store.save({ category: 'fact', subject: 'Ida_test', content: 'Keeps bees on the roof uniquely' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'bees roof' });
    expect(result).toContain(`[id:${id}]`);
  });

  it('ignores an invalid category instead of failing', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'fact', subject: 'Cat_test', content: 'Owns a grumpy cat uniquely' });

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'grumpy cat', category: 'Facts!' });
    expect(result).toContain('grumpy cat');
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
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read quantum flux links xyz123' });
    await store.save({ category: 'pain_point', subject: 'bot', content: 'Responds when absolutely nobody asked xyz123' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain('quantum flux');
    // pain_point should NOT appear when filtering to capability_gap
    expect(result).not.toContain('absolutely nobody asked xyz123');
  });

  it('returns all self-diagnosis categories when category is "all"', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot decode hieroglyphs unique_all_test' });
    await store.save({ category: 'pain_point', subject: 'bot', content: 'Too verbose in meme channel unique_all_test' });
    await store.save({ category: 'feature_request', subject: 'bot', content: 'Users want teleportation feature unique_all_test' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'all' });
    expect(result).toContain('hieroglyphs');
    expect(result).toContain('verbose');
    expect(result).toContain('teleportation');
  });

  it('returns "no self-diagnosis data" when no bot/server entries exist for a category', async () => {
    const store = getMemoryStore();
    // Save a non-bot entry in unrecognized_content (won't match the bot/server subject filter)
    await store.save({ category: 'unrecognized_content', subject: 'SomeRandomUser', content: 'Unrecognized content test entry' });

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

  it('falls back to the default limit for a non-numeric limit instead of throwing (regression: LIMIT NULL)', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Unique nan limit test error' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'tool_error', limit: 'lots' });
    expect(result).toContain('nan limit');
  });

  it('filters to only bot/server subjects', async () => {
    const store = getMemoryStore();
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot process antimatter images unique_filter' });
    await store.save({ category: 'capability_gap', subject: 'RandomPerson', content: 'RandomPerson specific issue unique_filter' });

    const result = await querySelfDiagnosisTool!.handler(stubCtx, { category: 'capability_gap' });
    expect(result).toContain('antimatter');
    expect(result).not.toContain('RandomPerson specific issue unique_filter');
  });

  it('prefixes every entry with [id:N] so forget_memory can remove it', async () => {
    const store = getMemoryStore();
    const id = await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot transcribe whale song recordings unique_id_test' });

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

describe('remember_fact tool', () => {
  it('warns the model that event memories expire and facts are permanent', () => {
    // Regression (incremental review): without this, the chat model can save a user's explicit
    // "remember that X happened" as an 'event' that silently disappears after the ~14-day TTL.
    expect(rememberFactTool!.description).toContain('expires automatically');
    expect(rememberFactTool!.description).toContain('use "fact" for anything that should be remembered permanently');
  });

  it('rejects a category outside the whitelist without saving anything', async () => {
    const result = await rememberFactTool!.handler(stubCtx, {
      category: 'capability_gap',
      subject: 'bot',
      content: 'sneaky self-diagnosis pollution',
    });
    expect(result).toMatch(/invalid category/i);
    expect(getMemoryStore().getAllActive()).toHaveLength(0);
  });

  it('normalizes category case and whitespace', async () => {
    const result = await rememberFactTool!.handler(stubCtx, { category: ' Fact ', subject: 'Case_test', content: 'Case test content' });
    expect(result).toMatch(/Saved to memory/);
    expect(getMemoryStore().getAllActive()[0].category).toBe('fact');
  });

  it('refuses empty content', async () => {
    const result = await rememberFactTool!.handler(stubCtx, { category: 'fact', subject: 'Empty_test', content: '   ' });
    expect(result).toMatch(/empty/i);
    expect(getMemoryStore().getAllActive()).toHaveLength(0);
  });
});

describe('forget_memory tool', () => {
  it('frames removal around corrections/supersession and warns off jokes', () => {
    expect(forgetMemoryTool!.description).toMatch(/correct|supersed/i);
    expect(forgetMemoryTool!.description).toMatch(/recall_memories/);
    expect(forgetMemoryTool!.description).toMatch(/jok|banter/i);
  });

  it('reports an unknown id instead of pretending it forgot something', async () => {
    const result = await forgetMemoryTool!.handler(stubCtx, { memory_id: 123456 });
    expect(result).toMatch(/no active memory/i);
  });

  it('rejects non-integer ids', async () => {
    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: true })).toBe('Invalid memory ID.');
    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: 1.5 })).toBe('Invalid memory ID.');
    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: 'abc' })).toBe('Invalid memory ID.');
  });

  it('accepts a numeric string id', async () => {
    const id = await getMemoryStore().save({ category: 'fact', subject: 'Str_test', content: 'String id test entry' });
    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: String(id) })).toContain(`#${id}`);
  });

  it('forgetting the same id twice is harmless and search keeps working (regression: FTS index corruption)', async () => {
    const store = getMemoryStore();
    const keep = await store.save({ category: 'fact', subject: 'Keep_test', content: 'Restores vintage typewriters' });
    const gone = await store.save({ category: 'fact', subject: 'Gone_test', content: 'Likes pangolins a lot' });

    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: gone })).toContain(`#${gone}`);
    expect(await forgetMemoryTool!.handler(stubCtx, { memory_id: gone })).toMatch(/no active memory/i);

    const result = await recallMemoriesTool!.handler(stubCtx, { query: 'vintage typewriters' });
    expect(result).toContain(`[id:${keep}]`);
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

describe('memories keyed by stable member id', () => {
  /** A tool context whose triggering message is from Jason (id 222…) unless overridden. */
  function ctxFor(opts: FakeMessageOptions = {}): ToolHandlerContext {
    const { message } = createFakeMessage({ authorId: '222222222222222222', authorDisplayName: 'Jason', ...opts });
    return { message } as ToolHandlerContext;
  }

  beforeEach(() => {
    const store = getMemoryStore();
    store.upsertIdentity('111111111111111111', 'OldNick');
    store.upsertIdentity('111111111111111111', 'Wheezer');
    store.updateIdentityMeta('111111111111111111', { irl_name: 'Derrick', aliases_add: ['Wheez'] });
    store.upsertIdentity('222222222222222222', 'Jason');
  });

  it('remember_fact files a memory about "me" under the speaker’s id and current display name', async () => {
    const result = await rememberFactTool!.handler(ctxFor(), { category: 'fact', subject: 'me', content: 'Works nights' });
    expect(result).toMatch(/^Saved to memory \(id: \d+\) about Jason\.$/);
    const [row] = getMemoryStore().getAllActive();
    expect(row.subject).toBe('Jason');
    expect(row.subject_user_id).toBe('222222222222222222');
  });

  it('remember_fact resolves a real name, nickname or old name to the member', async () => {
    const store = getMemoryStore();
    const facts: Record<string, string> = {
      Derrick: 'Owns a husky named Moose',
      wheez: 'Works as an electrician downtown',
      OldNick: 'Grew up in Sherbrooke',
      '@Wheezer': 'Plays bass in a cover band',
    };
    for (const [subject, content] of Object.entries(facts)) {
      await rememberFactTool!.handler(ctxFor(), { category: 'fact', subject, content });
    }
    const rows = store.getAllActive();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.subject).toBe('Wheezer');
      expect(row.subject_user_id).toBe('111111111111111111');
    }
  });

  it('remember_fact resolves an @-mentioned member the bot has no identity row for', async () => {
    const ctx = ctxFor({
      content: '<@1> remember <@444444444444444444> hates cilantro',
      mentionedUsers: [{ id: '444444444444444444', displayName: 'NewGuy' }],
    });
    const result = await rememberFactTool!.handler(ctx, { category: 'preference', subject: 'NewGuy', content: 'Hates cilantro' });
    expect(result).toContain('about NewGuy');
    expect(getMemoryStore().getAllActive()[0].subject_user_id).toBe('444444444444444444');
  });

  it('remember_fact keeps "server" and unknown subjects as written, without an id', async () => {
    await rememberFactTool!.handler(ctxFor(), { category: 'vibe', subject: 'Server', content: 'Movie night Fridays' });
    await rememberFactTool!.handler(ctxFor(), { category: 'fact', subject: 'Costco', content: 'Hot dog is still 1.50' });
    const rows = getMemoryStore().getAllActive();
    expect(rows.map((r) => [r.subject, r.subject_user_id]).sort()).toEqual([
      ['Costco', null],
      ['server', null],
    ]);
  });

  it('recall_memories finds a renamed member’s memories under every name, by subject or by query', async () => {
    const store = getMemoryStore();
    const byId = await store.save({ category: 'fact', subject: 'OldNick', subject_user_id: '111111111111111111', content: 'Plays bass' });
    const byIrlName = await store.save({ category: 'fact', subject: 'Derrick', content: 'Owns a husky named Moose' });
    await store.save({ category: 'fact', subject: 'Jason', subject_user_id: '222222222222222222', content: 'Drives a Miata' });

    const bySubject = await recallMemoriesTool!.handler(ctxFor(), { query: 'anything', subject: 'Wheezer' });
    expect(bySubject).toContain(`[id:${byId}]`);
    expect(bySubject).toContain(`[id:${byIrlName}]`);
    expect(bySubject).not.toContain('Miata');

    const byQuery = await recallMemoriesTool!.handler(ctxFor(), { query: 'wheez' });
    expect(byQuery).toContain(`[id:${byId}]`);
    expect(byQuery).toContain(`[id:${byIrlName}]`);

    const aboutMe = await recallMemoriesTool!.handler(ctxFor(), { query: 'me' });
    expect(aboutMe).toContain('Miata');
  });
});

describe('summarize_messages tool', () => {
  const summarizeTool = toolDefinitions.find((t) => t.name === 'summarize_messages');

  it('takes Eastern wall-clock times and "since my last message", and explains vague phrases', () => {
    const params = summarizeTool!.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties).sort()).toEqual(['end_time', 'since_my_last_message', 'start_time']);
    expect(params.required).toEqual([]);
    expect(summarizeTool!.description).toContain('Eastern');
    expect(summarizeTool!.description).toContain('"last night" ≈ 18:00 yesterday');
    expect(summarizeTool!.description).toContain('"this morning" ≈ 06:00 today');
    expect(summarizeTool!.description).toContain('"today" = since 00:00 today');
    expect(summarizeTool!.description).toContain('7 days');
  });

  it('answers bad arguments without touching Discord or OpenRouter', async () => {
    const fake = createFakeMessage();
    const ctx = { message: fake.message } as ToolHandlerContext;
    expect(await summarizeTool!.handler(ctx, { start_time: 'yesterday-ish' })).toMatch(/Invalid start_time/);
    expect(fake.recorders.messagesFetch.calls).toHaveLength(0);
  });
});

describe('get_emoji tool', () => {
  beforeEach(() => {
    const store = getMemoryStore();
    store.upsertEmoji({ id: '111', name: 'trolle', animated: false });
    store.setEmojiCaption('111', 'trollface; for provocation, trolling');
    store.upsertEmoji({ id: '222', name: 'monkaS', animated: true });
    store.setEmojiCaption('222', 'sweating Pepe; for panic, shock');
  });

  it('tells the model to hold back unless it has already decided on an emoji', () => {
    expect(getEmojiTool!.description).toMatch(/most replies never need one/i);
  });

  it('finds an emoji by name and returns the exact posting syntax', async () => {
    const result = await getEmojiTool!.handler(stubCtx, { query: 'trolle' });
    expect(result).toContain('<:trolle:111>');
    expect(result).not.toContain('monkaS');
  });

  it('finds an emoji by the reaction described in its caption (animated syntax)', async () => {
    const result = await getEmojiTool!.handler(stubCtx, { query: 'panic' });
    expect(result).toContain('<a:monkaS:222>');
  });

  it('tells the model to reply in plain text when nothing matches', async () => {
    expect(await getEmojiTool!.handler(stubCtx, { query: 'volcano' })).toMatch(/plain text/i);
    expect(await getEmojiTool!.handler(stubCtx, {})).toMatch(/plain text/i);
  });
});
