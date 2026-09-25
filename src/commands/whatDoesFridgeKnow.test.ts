import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Memory } from '../ai/memory/memoryStore';
import { MemoryStore } from '../ai/memory/memoryStore';
import { createFakeCommandDeps, createFakeUserCommandInteraction } from '../test-support/fakeInteraction';
import { handleContextMenuCommand } from './index';
import { MAX_LISTED_MEMORIES, renderMemoryList } from './whatDoesFridgeKnow';

let store: MemoryStore;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = new MemoryStore(':memory:');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-09-25T16:00:00Z');

function memory(id: number, content: string, category = 'fact'): Memory {
  return {
    id,
    category,
    subject: 'Jason',
    content,
    source: 'conversation',
    created_at: '2026-09-20 12:00:00',
    updated_at: '2026-09-20 12:00:00',
    active: 1,
    subject_user_id: 'user-7',
  };
}

describe('What does Fridge know?', () => {
  it("lists memories matched by id or any of the person's names, privately", async () => {
    store.upsertIdentity('user-7', 'Jason');
    store.updateIdentityMeta('user-7', { aliases_add: ['Jay'] });
    await store.save({ category: 'fact', subject: 'Jason', content: 'Still plays on PS4.', subject_user_id: 'user-7' });
    await store.save({ category: 'preference', subject: 'Jay', content: 'Hates cilantro.' });
    await store.save({ category: 'fact', subject: 'Simon', content: 'Drives a Civic.' });
    await store.save({ category: 'capability_gap', subject: 'Jason', content: 'Bot cannot read PDFs.', subject_user_id: 'user-7' });

    const { interaction, responses } = createFakeUserCommandInteraction(
      { id: 'user-7', username: 'jason99', memberDisplayName: 'Jason' },
      { commandName: 'What does Fridge know?' },
    );
    // Real clock: the rows were just saved with SQLite's datetime('now').
    await handleContextMenuCommand(interaction, createFakeCommandDeps({ store, now: new Date() }).deps);

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'reply', ephemeral: true });
    const text = responses[0].content ?? '';
    expect(text.split('\n')[0]).toBe('**What I know about Jason** (2)');
    expect(text).toContain('Still plays on PS4.');
    expect(text).toContain('Hates cilantro.');
    expect(text).not.toContain('Civic');
    // Bot self-diagnosis rows are not "knowledge about a person".
    expect(text).not.toContain('PDFs');
    expect(text).toMatch(/`#\d+` Still plays on PS4\. \*\(fact, today\)\*/);
  });

  it('says so when it knows nothing', async () => {
    const { interaction, responses } = createFakeUserCommandInteraction(
      { id: 'user-9', username: 'newguy', memberDisplayName: null },
      { commandName: 'What does Fridge know?' },
    );
    await handleContextMenuCommand(interaction, createFakeCommandDeps({ store }).deps);
    expect(responses[0]).toMatchObject({ content: "I've got nothing on newguy yet", ephemeral: true });
  });

  it('reports a broken memory store in character', async () => {
    const { interaction, responses } = createFakeUserCommandInteraction(
      { id: 'user-7', memberDisplayName: 'Jason' },
      { commandName: 'What does Fridge know?' },
    );
    const broken = store;
    broken.close();
    await handleContextMenuCommand(interaction, createFakeCommandDeps({ store: broken }).deps);
    expect(responses[0]).toMatchObject({ method: 'reply', ephemeral: true, content: 'ugh, that one broke on my end. try again in a bit' });
  });
});

describe('renderMemoryList', () => {
  it(`shows at most ${MAX_LISTED_MEMORIES}, newest first, and says how many exist`, () => {
    const memories = Array.from({ length: 40 }, (_, i) => memory(100 - i, `fact number ${i}`));
    const text = renderMemoryList('Jason', memories, NOW);
    const lines = text.split('\n');
    expect(lines[0]).toBe(`**What I know about Jason** (newest ${MAX_LISTED_MEMORIES} of 40)`);
    expect(lines).toHaveLength(MAX_LISTED_MEMORIES + 1);
    expect(lines[1]).toBe('`#100` fact number 0 *(fact, 5d ago)*');
  });

  it('fits long memories into one message and counts only what is shown', () => {
    const memories = Array.from({ length: 25 }, (_, i) => memory(i + 1, `${'long content '.repeat(30)}${i}`));
    const text = renderMemoryList('Jason', memories, NOW);
    expect(text.length).toBeLessThanOrEqual(2000);
    const shown = text.split('\n').length - 1;
    expect(shown).toBeLessThan(25);
    expect(text.split('\n')[0]).toBe(`**What I know about Jason** (newest ${shown} of 25)`);
  });

  it('escapes markdown in names and contents', () => {
    const text = renderMemoryList('_under_', [memory(1, 'likes **bold** things')], NOW);
    expect(text).toContain('\\_under\\_');
    expect(text).toContain('likes \\*\\*bold\\*\\* things');
  });
});
