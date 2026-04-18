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

  it('search() handles commas in query', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = store.search('Felix, cats');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('cats');
  });

  it('search() handles quotes in query', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix has a nickname' });
    const results = store.search('Felix "nickname"');
    expect(results).toHaveLength(1);
  });

  it('search() handles parentheses in query', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = store.search('(Felix)');
    expect(results).toHaveLength(1);
  });

  it('search() returns empty for query that is all special characters', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = store.search(',,,');
    expect(results).toEqual([]);
  });

  it('search() handles mixed valid and special chars', () => {
    store.save({ category: 'fact', subject: 'Felix', content: 'Felix has cats and dogs' });
    const results = store.search("Felix's cats, dogs");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Felix');
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

describe('subject_user_id (soft-FK to identities)', () => {
  it('save() defaults subject_user_id to null when omitted', () => {
    const id = store.save({ category: 'fact', subject: 'Wheezer', content: 'Likes cats' });
    const row = store.getAllActive().find((m) => m.id === id);
    expect(row?.subject_user_id).toBeNull();
  });

  it('save() persists subject_user_id when provided', () => {
    const id = store.save({
      category: 'fact',
      subject: 'Wheezer',
      content: 'Likes cats',
      subject_user_id: '123',
    });
    const row = store.getAllActive().find((m) => m.id === id);
    expect(row?.subject_user_id).toBe('123');
  });
});

describe('identities', () => {
  it('getIdentityById() returns undefined for unknown IDs', () => {
    expect(store.getIdentityById('unknown-id')).toBeUndefined();
  });

  it('upsertIdentity() creates a new row with canonical_name equal to display_name', () => {
    store.upsertIdentity('123', 'Wheezer');
    const identity = store.getIdentityById('123');
    expect(identity).toBeDefined();
    expect(identity?.display_name).toBe('Wheezer');
    expect(identity?.canonical_name).toBe('Wheezer');
    expect(identity?.irl_name).toBeNull();
    expect(identity?.aliases).toEqual([]);
  });

  it('upsertIdentity() updates display_name but preserves canonical_name on rename', () => {
    store.upsertIdentity('123', 'Wheezer');
    store.upsertIdentity('123', 'wheezyboy2');

    const identity = store.getIdentityById('123');
    expect(identity?.display_name).toBe('wheezyboy2');
    expect(identity?.canonical_name).toBe('Wheezer');
  });

  it('upsertIdentity() is idempotent when display_name unchanged', () => {
    store.upsertIdentity('123', 'Wheezer');
    const first = store.getIdentityById('123');
    const firstUpdated = first?.updated_at;

    // Same name — should not bump updated_at
    store.upsertIdentity('123', 'Wheezer');
    const second = store.getIdentityById('123');
    expect(second?.updated_at).toBe(firstUpdated);
  });

  it('updateIdentityMeta() returns false for unknown IDs', () => {
    expect(store.updateIdentityMeta('unknown-id', { irl_name: 'Ghost' })).toBe(false);
  });

  it('updateIdentityMeta() sets irl_name on a known identity', () => {
    store.upsertIdentity('123', 'Wheezer');
    const changed = store.updateIdentityMeta('123', { irl_name: 'Derrick' });
    expect(changed).toBe(true);
    expect(store.getIdentityById('123')?.irl_name).toBe('Derrick');
  });

  it('updateIdentityMeta() returns false when irl_name is identical', () => {
    store.upsertIdentity('123', 'Wheezer');
    store.updateIdentityMeta('123', { irl_name: 'Derrick' });
    expect(store.updateIdentityMeta('123', { irl_name: 'Derrick' })).toBe(false);
  });

  it('updateIdentityMeta() ignores empty irl_name strings', () => {
    store.upsertIdentity('123', 'Wheezer');
    const changed = store.updateIdentityMeta('123', { irl_name: '   ' });
    expect(changed).toBe(false);
    expect(store.getIdentityById('123')?.irl_name).toBeNull();
  });

  it('updateIdentityMeta() appends aliases and dedupes', () => {
    store.upsertIdentity('123', 'Wheezer');

    store.updateIdentityMeta('123', { aliases_add: ['Derek', 'D'] });
    expect(store.getIdentityById('123')?.aliases).toEqual(['Derek', 'D']);

    // Duplicate alias should not re-append
    const changed = store.updateIdentityMeta('123', { aliases_add: ['Derek', 'D-man'] });
    expect(changed).toBe(true);
    expect(store.getIdentityById('123')?.aliases).toEqual(['Derek', 'D', 'D-man']);
  });

  it('updateIdentityMeta() returns false when no meaningful aliases are added', () => {
    store.upsertIdentity('123', 'Wheezer');
    store.updateIdentityMeta('123', { aliases_add: ['Derek'] });
    expect(store.updateIdentityMeta('123', { aliases_add: ['Derek'] })).toBe(false);
    expect(store.updateIdentityMeta('123', { aliases_add: ['   '] })).toBe(false);
  });

  it('getAllIdentities() returns rows ordered by canonical_name', () => {
    store.upsertIdentity('2', 'Zack');
    store.upsertIdentity('1', 'Anna');
    store.upsertIdentity('3', 'Mike');

    const all = store.getAllIdentities();
    expect(all.map((i) => i.canonical_name)).toEqual(['Anna', 'Mike', 'Zack']);
  });

  it('getAllIdentities() returns parsed aliases', () => {
    store.upsertIdentity('1', 'Anna');
    store.updateIdentityMeta('1', { aliases_add: ['Annie', 'A'] });

    const [identity] = store.getAllIdentities();
    expect(identity.aliases).toEqual(['Annie', 'A']);
  });
});

describe('emojis', () => {
  it('upsertEmoji() inserts a new row as active with null caption', () => {
    const result = store.upsertEmoji({ id: '111', name: 'ratirlPickle', animated: false });
    expect(result.inserted).toBe(true);
    expect(result.nameChanged).toBe(false);

    const row = store.getEmojiById('111');
    expect(row?.name).toBe('ratirlPickle');
    expect(row?.animated).toBe(0);
    expect(row?.active).toBe(1);
    expect(row?.caption).toBeNull();
  });

  it('upsertEmoji() preserves caption when re-upserting with same name', () => {
    store.upsertEmoji({ id: '111', name: 'ratirlPickle', animated: false });
    store.setEmojiCaption('111', 'green pickle for absurdity');

    const result = store.upsertEmoji({ id: '111', name: 'ratirlPickle', animated: false });
    expect(result.inserted).toBe(false);
    expect(result.nameChanged).toBe(false);
    expect(store.getEmojiById('111')?.caption).toBe('green pickle for absurdity');
  });

  it('upsertEmoji() reports nameChanged when the name differs', () => {
    store.upsertEmoji({ id: '111', name: 'oldName', animated: false });
    const result = store.upsertEmoji({ id: '111', name: 'newName', animated: false });
    expect(result.inserted).toBe(false);
    expect(result.nameChanged).toBe(true);
    expect(store.getEmojiById('111')?.name).toBe('newName');
  });

  it('upsertEmoji() reactivates a previously deactivated emoji', () => {
    store.upsertEmoji({ id: '111', name: 'pickle', animated: false });
    store.deactivateEmoji('111');
    expect(store.getEmojiById('111')?.active).toBe(0);

    store.upsertEmoji({ id: '111', name: 'pickle', animated: false });
    expect(store.getEmojiById('111')?.active).toBe(1);
  });

  it('setEmojiCaption() updates caption and sets captioned_at', () => {
    store.upsertEmoji({ id: '111', name: 'pickle', animated: false });
    store.setEmojiCaption('111', 'a cartoon pickle');

    const row = store.getEmojiById('111');
    expect(row?.caption).toBe('a cartoon pickle');
    expect(row?.captioned_at).toBeTruthy();
  });

  it('deactivateEmoji() sets active=0 without hard delete', () => {
    store.upsertEmoji({ id: '111', name: 'pickle', animated: false });
    store.deactivateEmoji('111');

    expect(store.getEmojiById('111')?.active).toBe(0);
    expect(store.getUsableEmojis()).toEqual([]);
  });

  it('getUsableEmojis() returns only active emojis, ordered by name', () => {
    store.upsertEmoji({ id: '1', name: 'zebra', animated: false });
    store.upsertEmoji({ id: '2', name: 'apple', animated: true });
    store.upsertEmoji({ id: '3', name: 'mango', animated: false });
    store.deactivateEmoji('2');

    const usable = store.getUsableEmojis();
    expect(usable.map((e) => e.name)).toEqual(['mango', 'zebra']);
  });

  it('getEmojisNeedingCaption() returns active uncaptioned emojis', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    store.upsertEmoji({ id: '2', name: 'b', animated: false });
    store.upsertEmoji({ id: '3', name: 'c', animated: false });
    store.setEmojiCaption('2', 'caption for b');
    store.deactivateEmoji('3');

    const needing = store.getEmojisNeedingCaption();
    expect(needing.map((e) => e.id)).toEqual(['1']);
  });

  it('upsertEmoji() defaults use_count to 0 and last_used_at to null', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    const row = store.getEmojiById('1');
    expect(row?.use_count).toBe(0);
    expect(row?.last_used_at).toBeNull();
  });

  it('incrementEmojiUsage() bumps counter and sets last_used_at on active emoji', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    const changed = store.incrementEmojiUsage('1');
    expect(changed).toBe(true);

    const row = store.getEmojiById('1');
    expect(row?.use_count).toBe(1);
    expect(row?.last_used_at).toBeTruthy();
  });

  it('incrementEmojiUsage() accepts a custom delta', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    store.incrementEmojiUsage('1', 3);
    expect(store.getEmojiById('1')?.use_count).toBe(3);
  });

  it('incrementEmojiUsage() is a no-op for unknown emoji IDs', () => {
    expect(store.incrementEmojiUsage('does-not-exist')).toBe(false);
  });

  it('incrementEmojiUsage() is a no-op for deactivated emojis', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    store.deactivateEmoji('1');
    expect(store.incrementEmojiUsage('1')).toBe(false);
    expect(store.getEmojiById('1')?.use_count).toBe(0);
  });

  it('clearAllEmojiCaptions() nulls caption and captioned_at across all rows', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: false });
    store.upsertEmoji({ id: '2', name: 'b', animated: false });
    store.setEmojiCaption('1', 'caption for a');
    store.setEmojiCaption('2', 'caption for b');

    const cleared = store.clearAllEmojiCaptions();
    expect(cleared).toBe(2);

    expect(store.getEmojiById('1')?.caption).toBeNull();
    expect(store.getEmojiById('1')?.captioned_at).toBeNull();
    expect(store.getEmojiById('2')?.caption).toBeNull();
    expect(store.getEmojiById('2')?.captioned_at).toBeNull();
  });

  it('clearAllEmojiCaptions() preserves other fields', () => {
    store.upsertEmoji({ id: '1', name: 'a', animated: true });
    store.setEmojiCaption('1', 'original caption');
    store.incrementEmojiUsage('1', 5);

    store.clearAllEmojiCaptions();

    const row = store.getEmojiById('1');
    expect(row?.name).toBe('a');
    expect(row?.animated).toBe(1);
    expect(row?.use_count).toBe(5);
    expect(row?.active).toBe(1);
  });

  it('getUsableEmojis() orders by use_count desc, then name asc', () => {
    store.upsertEmoji({ id: '1', name: 'banana', animated: false });
    store.upsertEmoji({ id: '2', name: 'apple', animated: false });
    store.upsertEmoji({ id: '3', name: 'cherry', animated: false });

    store.incrementEmojiUsage('3', 5); // cherry: 5
    store.incrementEmojiUsage('1', 2); // banana: 2
    // apple: 0 (ties broken by name asc)

    const ordered = store.getUsableEmojis().map((e) => e.name);
    expect(ordered).toEqual(['cherry', 'banana', 'apple']);
  });
});
