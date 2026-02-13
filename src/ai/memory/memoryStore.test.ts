import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './memoryStore';

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(':memory:');
});

afterEach(() => {
  // @ts-expect-error accessing private db for cleanup
  store.db.close();
});

describe('CRUD basics', () => {
  it('save() returns a positive integer id', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it('save() stores source as "conversation" by default', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('conversation');
  });

  it('save() stores custom source when provided', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats', source: 'observation' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('observation');
  });

  it('getAllActive() returns empty array on fresh store', () => {
    expect(store.getAllActive()).toEqual([]);
  });

  it('getAllActive() excludes deactivated memories', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
  });

  it('getBySubject() filters by exact subject', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.save({ category: 'fact', subject: 'Alex', content: 'Likes dogs' });
    const results = store.getBySubject('Felix');
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('Felix');
  });

  it('getBySubject() respects limit param', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.save({ category: 'preference', subject: 'Felix', content: 'Prefers tea' });
    store.save({ category: 'fact', subject: 'Felix', content: 'Lives in Toronto' });
    const results = store.getBySubject('Felix', 2);
    expect(results).toHaveLength(2);
  });

  it('getBySubject() excludes inactive', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getBySubject('Felix')).toEqual([]);
  });

  it('getByCategory() filters by category', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.save({ category: 'preference', subject: 'Felix', content: 'Prefers tea' });
    const results = store.getByCategory('fact');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('fact');
  });

  it('getRecent() returns newest-first and respects limit', () => {
    const id1 = store.save({ category: 'fact', subject: 'A', content: 'First memory' });
    const id2 = store.save({ category: 'fact', subject: 'B', content: 'Second memory' });
    const id3 = store.save({ category: 'fact', subject: 'C', content: 'Third memory' });

    // Manually set different timestamps so ordering is deterministic
    // @ts-expect-error accessing private db for test setup
    const db = store.db;
    db.prepare("UPDATE memories SET updated_at = datetime('now', '-2 minutes') WHERE id = ?").run(id1);
    db.prepare("UPDATE memories SET updated_at = datetime('now', '-1 minutes') WHERE id = ?").run(id2);
    db.prepare("UPDATE memories SET updated_at = datetime('now') WHERE id = ?").run(id3);

    const results = store.getRecent(2);
    expect(results).toHaveLength(2);
    expect(results[0].subject).toBe('C');
    expect(results[1].subject).toBe('B');
  });
});

describe('FTS5 search', () => {
  it('search() finds by content keyword', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Loves programming in TypeScript' });
    const results = store.search('TypeScript');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('search() finds by subject', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    const results = store.search('Felix');
    expect(results).toHaveLength(1);
  });

  it('search() returns only active memories', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.search('cats')).toEqual([]);
  });

  it('search() respects limit', () => {
    store.save({ category: 'fact', subject: 'A', content: 'Likes cats very much' });
    store.save({ category: 'fact', subject: 'B', content: 'Also likes cats a lot' });
    const results = store.search('cats', 1);
    expect(results).toHaveLength(1);
  });

  it('search() returns empty for no matches', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    expect(store.search('dinosaurs')).toEqual([]);
  });

  it('search() stays in sync after deactivate', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(store.search('pangolins')).toEqual([]);
  });

  it('search() stays in sync after remove', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.remove(id);
    expect(store.search('pangolins')).toEqual([]);
  });
});

describe('dedup on save (word overlap)', () => {
  it('updates existing row when same category+subject and >60% word overlap', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    const id2 = store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' });
    expect(id2).toBe(id1);
    const all = store.getAllActive();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('Felix lives in Montreal Canada downtown');
  });

  it('creates a new row when overlap <= 60%', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much' });
    const id2 = store.save({ category: 'fact', subject: 'Felix', content: 'Works as a plumber downtown' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different subjects', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much indeed' });
    const id2 = store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different categories', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much indeed' });
    const id2 = store.save({ category: 'preference', subject: 'Felix', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('FTS index reflects updated content after dedup merge', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' });
    // Old content should not be findable
    expect(store.search('Toronto')).toEqual([]);
    // New content should be findable
    expect(store.search('Montreal')).toHaveLength(1);
  });

  it('does NOT dedup against deactivated memories', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    store.deactivate(id1);
    const id2 = store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' });
    expect(id2).not.toBe(id1);
  });
});

describe('deactivate() and remove()', () => {
  it('deactivate() sets active=0 and memory disappears from active queries', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
    expect(store.getBySubject('Felix')).toEqual([]);
  });

  it('deactivate() removes from FTS index', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(store.search('pangolins')).toEqual([]);
  });

  it('deactivate() is a no-op for nonexistent ids', () => {
    expect(() => store.deactivate(999)).not.toThrow();
  });

  it('remove() permanently deletes the row', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.remove(id);
    expect(store.getAllActive()).toEqual([]);
    // @ts-expect-error accessing private db to verify row is gone
    const row = store.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('remove() removes from FTS index', () => {
    const id = store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.remove(id);
    expect(store.search('pangolins')).toEqual([]);
  });
});

describe('compact()', () => {
  it('returns {merged: 0, removed: 0} on empty store', () => {
    expect(store.compact()).toEqual({ merged: 0, removed: 0 });
  });

  it('deactivates older overlapping memories when same subject+category', () => {
    // Insert two memories that are BELOW 60% overlap at save time
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    const id2 = store.save({ category: 'fact', subject: 'Felix', content: 'Enjoys swimming every weekend morning' });
    expect(store.getAllActive()).toHaveLength(2);

    // Manually update one via raw SQL to make them overlap >60%
    // @ts-expect-error accessing private db for test setup
    store.db
      .prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed' WHERE id = ?")
      .run(id2);

    const result = store.compact();
    expect(result.removed).toBeGreaterThanOrEqual(1);

    // The older one should be deactivated, newer one kept
    const active = store.getAllActive();
    expect(active).toHaveLength(1);
  });

  it('keeps the newer memory (by updated_at)', () => {
    const id1 = store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    const id2 = store.save({ category: 'fact', subject: 'Felix', content: 'Enjoys swimming every weekend morning' });

    // Make id2 older so id1 is newer
    // @ts-expect-error accessing private db for test setup
    store.db
      .prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed', updated_at = datetime('now', '-1 hour') WHERE id = ?")
      .run(id2);

    store.compact();
    const active = store.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(id1);
  });

  it('does not touch memories with different subjects or categories', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats and dogs very much' });
    store.save({ category: 'preference', subject: 'Felix', content: 'Likes cats and dogs very much' });

    const result = store.compact();
    expect(result.removed).toBe(0);
    expect(store.getAllActive()).toHaveLength(3);
  });
});

describe('new self-improvement categories', () => {
  it('stores and retrieves capability_gap category', () => {
    store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot process PDF attachments' });
    const results = store.getByCategory('capability_gap');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Cannot process PDF attachments');
  });

  it('stores and retrieves pain_point category', () => {
    store.save({ category: 'pain_point', subject: 'bot', content: 'Responds when nobody asked' });
    const results = store.getByCategory('pain_point');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Responds when nobody asked');
  });

  it('stores and retrieves feature_request category', () => {
    store.save({ category: 'feature_request', subject: 'bot', content: 'Add reminder functionality' });
    const results = store.getByCategory('feature_request');
    expect(results).toHaveLength(1);
  });

  it('stores and retrieves improvement_idea category', () => {
    store.save({ category: 'improvement_idea', subject: 'bot', content: 'Use shorter responses in meme channels' });
    const results = store.getByCategory('improvement_idea');
    expect(results).toHaveLength(1);
  });

  it('stores and retrieves tool_error category', () => {
    store.save({ category: 'tool_error', subject: 'bot', content: 'Image generation failed', source: 'self-diagnosis' });
    const results = store.getByCategory('tool_error');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('self-diagnosis');
  });

  it('stores and retrieves parse_failure category', () => {
    store.save({ category: 'parse_failure', subject: 'bot', content: 'Empty LLM response', source: 'self-diagnosis' });
    const results = store.getByCategory('parse_failure');
    expect(results).toHaveLength(1);
  });

  it('search() finds new category content via FTS', () => {
    store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot process custom Discord emojis' });
    const results = store.search('emojis');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('capability_gap');
  });

  it('getBySubject("bot") returns self-diagnosis entries', () => {
    store.save({ category: 'tool_error', subject: 'bot', content: 'Error in image tool' });
    store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read links' });
    store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });

    const botResults = store.getBySubject('bot');
    expect(botResults).toHaveLength(2);
    expect(botResults.every((r) => r.subject === 'bot')).toBe(true);
  });

  it('compact() works across new categories', () => {
    const id1 = store.save({ category: 'tool_error', subject: 'bot', content: 'Image generation tool failed unexpectedly' });
    const id2 = store.save({ category: 'tool_error', subject: 'bot', content: 'Something totally different happened in summary' });

    // Make them overlap via raw SQL
    // @ts-expect-error accessing private db for test setup
    store.db
      .prepare("UPDATE memories SET content = 'Image generation tool failed unexpectedly again' WHERE id = ?")
      .run(id2);

    const result = store.compact();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    const active = store.getAllActive();
    expect(active).toHaveLength(1);
  });
});

describe('learner state', () => {
  it('getLastObserved() returns null for unknown channels', () => {
    expect(store.getLastObserved('unknown-channel')).toBeNull();
  });

  it('setLastObserved() + getLastObserved() round-trips correctly', () => {
    store.setLastObserved('channel-1', 'msg-123');
    expect(store.getLastObserved('channel-1')).toBe('msg-123');
  });

  it('setLastObserved() upserts (second call updates, no duplicate)', () => {
    store.setLastObserved('channel-1', 'msg-100');
    store.setLastObserved('channel-1', 'msg-200');
    expect(store.getLastObserved('channel-1')).toBe('msg-200');

    // Verify no duplicate rows
    // @ts-expect-error accessing private db for verification
    const rows = store.db.prepare('SELECT * FROM learner_state WHERE channel_id = ?').all('channel-1');
    expect(rows).toHaveLength(1);
  });
});
