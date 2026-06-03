import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingProvider } from '../../test-support/fakeEmbeddings';
import type { EmbeddingKind } from './embeddingProvider';
import { buildEmbeddingInput, MemoryStore } from './memoryStore';
import { blobToVector, cosineSimilarity, vectorToBlob } from './vectorMath';
import { wordOverlap } from './wordOverlap';

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(':memory:');
});

afterEach(() => {
  // @ts-expect-error accessing private db for cleanup
  store.db.close();
});

describe('CRUD basics', () => {
  it('save() returns a positive integer id', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it('save() stores source as "conversation" by default', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('conversation');
  });

  it('save() stores custom source when provided', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats', source: 'observation' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('observation');
  });

  it('getAllActive() returns empty array on fresh store', () => {
    expect(store.getAllActive()).toEqual([]);
  });

  it('getAllActive() excludes deactivated memories', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
  });

  it('getBySubject() filters by exact subject', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    await store.save({ category: 'fact', subject: 'Alex', content: 'Likes dogs' });
    const results = store.getBySubject('Felix');
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('Felix');
  });

  it('getBySubject() respects limit param', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    await store.save({ category: 'preference', subject: 'Felix', content: 'Prefers tea' });
    await store.save({ category: 'fact', subject: 'Felix', content: 'Lives in Toronto' });
    const results = store.getBySubject('Felix', 2);
    expect(results).toHaveLength(2);
  });

  it('getBySubject() excludes inactive', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getBySubject('Felix')).toEqual([]);
  });

  it('getByCategory() filters by category', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    await store.save({ category: 'preference', subject: 'Felix', content: 'Prefers tea' });
    const results = store.getByCategory('fact');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('fact');
  });

  it('getRecent() returns newest-first and respects limit', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'A', content: 'First memory' });
    const id2 = await store.save({ category: 'fact', subject: 'B', content: 'Second memory' });
    const id3 = await store.save({ category: 'fact', subject: 'C', content: 'Third memory' });

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
  it('search() finds by content keyword', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Loves programming in TypeScript' });
    const results = await store.search('TypeScript');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('search() finds by subject', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    const results = await store.search('Felix');
    expect(results).toHaveLength(1);
  });

  it('search() returns only active memories', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(await store.search('cats')).toEqual([]);
  });

  it('search() respects limit', async () => {
    await store.save({ category: 'fact', subject: 'A', content: 'Likes cats very much' });
    await store.save({ category: 'fact', subject: 'B', content: 'Also likes cats a lot' });
    const results = await store.search('cats', 1);
    expect(results).toHaveLength(1);
  });

  it('search() returns empty for no matches', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    expect(await store.search('dinosaurs')).toEqual([]);
  });

  it('search() stays in sync after deactivate', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('search() stays in sync after remove', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.remove(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('search() handles commas in query', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = await store.search('Felix, cats');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('cats');
  });

  it('search() handles quotes in query', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix has a nickname' });
    const results = await store.search('Felix "nickname"');
    expect(results).toHaveLength(1);
  });

  it('search() handles parentheses in query', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = await store.search('(Felix)');
    expect(results).toHaveLength(1);
  });

  it('search() returns empty for query that is all special characters', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix likes cats' });
    const results = await store.search(',,,');
    expect(results).toEqual([]);
  });

  it('search() handles mixed valid and special chars', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix has cats and dogs' });
    const results = await store.search("Felix's cats, dogs");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Felix');
  });
});

describe('dedup on save (word overlap)', () => {
  it('updates existing row when same category+subject and >60% word overlap', async () => {
    const id1 = await store.save({
      category: 'fact',
      subject: 'Felix',
      content: 'Felix lives in Toronto Canada downtown',
    });
    const id2 = await store.save({
      category: 'fact',
      subject: 'Felix',
      content: 'Felix lives in Montreal Canada downtown',
    });
    expect(id2).toBe(id1);
    const all = store.getAllActive();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('Felix lives in Montreal Canada downtown');
  });

  it('creates a new row when overlap <= 60%', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Felix', content: 'Works as a plumber downtown' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different subjects', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much indeed' });
    const id2 = await store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different categories', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats very much indeed' });
    const id2 = await store.save({ category: 'preference', subject: 'Felix', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('FTS index reflects updated content after dedup merge', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' });
    // Old content should not be findable
    expect(await store.search('Toronto')).toEqual([]);
    // New content should be findable
    expect(await store.search('Montreal')).toHaveLength(1);
  });

  it('does NOT dedup against deactivated memories', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    store.deactivate(id1);
    const id2 = await store.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' });
    expect(id2).not.toBe(id1);
  });
});

describe('deactivate() and remove()', () => {
  it('deactivate() sets active=0 and memory disappears from active queries', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
    expect(store.getBySubject('Felix')).toEqual([]);
  });

  it('deactivate() removes from FTS index', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('deactivate() is a no-op for nonexistent ids', () => {
    expect(() => store.deactivate(999)).not.toThrow();
  });

  it('remove() permanently deletes the row', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });
    store.remove(id);
    expect(store.getAllActive()).toEqual([]);
    // @ts-expect-error accessing private db to verify row is gone
    const row = store.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('remove() removes from FTS index', async () => {
    const id = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes pangolins' });
    store.remove(id);
    expect(await store.search('pangolins')).toEqual([]);
  });
});

describe('compact()', () => {
  it('returns {removed: 0, expired: 0} on empty store', () => {
    // The legacy `merged` field was dropped (it was hard-coded to 0 and never used by any caller).
    // `expired` counts ephemeral memories deactivated by the TTL sweep (compact() step 0).
    expect(store.compact()).toEqual({ removed: 0, expired: 0 });
  });

  it('deactivates older overlapping memories when same subject+category', async () => {
    // Insert two memories that are BELOW 60% overlap at save time
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Felix', content: 'Enjoys swimming every weekend morning' });
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

  it('keeps the newer memory (by updated_at)', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Felix', content: 'Enjoys swimming every weekend morning' });

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

  it('does not touch memories with different subjects or categories', async () => {
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats and dogs very much' });
    await store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats and dogs very much' });
    await store.save({ category: 'preference', subject: 'Felix', content: 'Likes cats and dogs very much' });

    const result = store.compact();
    expect(result.removed).toBe(0);
    expect(store.getAllActive()).toHaveLength(3);
  });
});

describe('new self-improvement categories', () => {
  it('stores and retrieves capability_gap category', async () => {
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot process PDF attachments' });
    const results = store.getByCategory('capability_gap');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Cannot process PDF attachments');
  });

  it('stores and retrieves pain_point category', async () => {
    await store.save({ category: 'pain_point', subject: 'bot', content: 'Responds when nobody asked' });
    const results = store.getByCategory('pain_point');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Responds when nobody asked');
  });

  it('stores and retrieves feature_request category', async () => {
    await store.save({ category: 'feature_request', subject: 'bot', content: 'Add reminder functionality' });
    const results = store.getByCategory('feature_request');
    expect(results).toHaveLength(1);
  });

  it('stores and retrieves improvement_idea category', async () => {
    await store.save({ category: 'improvement_idea', subject: 'bot', content: 'Use shorter responses in meme channels' });
    const results = store.getByCategory('improvement_idea');
    expect(results).toHaveLength(1);
  });

  it('stores and retrieves tool_error category', async () => {
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Image generation failed', source: 'self-diagnosis' });
    const results = store.getByCategory('tool_error');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('self-diagnosis');
  });

  it('stores and retrieves parse_failure category', async () => {
    await store.save({ category: 'parse_failure', subject: 'bot', content: 'Empty LLM response', source: 'self-diagnosis' });
    const results = store.getByCategory('parse_failure');
    expect(results).toHaveLength(1);
  });

  it('search() excludes self-diagnosis categories (changed behavior: capability_gap is no longer searchable)', async () => {
    // Self-diagnosis memories describe the bot, not the server — search() excludes them by default
    // (SELF_DIAGNOSIS_CATEGORIES) so they can't pollute conversational recall. getByCategory() /
    // the query_self_diagnosis tool remain their dedicated access path.
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot process custom Discord emojis' });
    const results = await store.search('emojis');
    expect(results).toEqual([]);
    // Still reachable via the dedicated access path
    const byCategory = store.getByCategory('capability_gap');
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0].content).toBe('Cannot process custom Discord emojis');
  });

  it('getBySubject("bot") returns self-diagnosis entries', async () => {
    await store.save({ category: 'tool_error', subject: 'bot', content: 'Error in image tool' });
    await store.save({ category: 'capability_gap', subject: 'bot', content: 'Cannot read links' });
    await store.save({ category: 'fact', subject: 'Felix', content: 'Likes cats' });

    const botResults = store.getBySubject('bot');
    expect(botResults).toHaveLength(2);
    expect(botResults.every((r) => r.subject === 'bot')).toBe(true);
  });

  it('compact() works across new categories', async () => {
    const id1 = await store.save({
      category: 'tool_error',
      subject: 'bot',
      content: 'Image generation tool failed unexpectedly',
    });
    const id2 = await store.save({
      category: 'tool_error',
      subject: 'bot',
      content: 'Something totally different happened in summary',
    });

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
  it('save() defaults subject_user_id to null when omitted', async () => {
    const id = await store.save({ category: 'fact', subject: 'Wheezer', content: 'Likes cats' });
    const row = store.getAllActive().find((m) => m.id === id);
    expect(row?.subject_user_id).toBeNull();
  });

  it('save() persists subject_user_id when provided', async () => {
    const id = await store.save({
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

// ---------------------------------------------------------------------------
// Semantic memory (embedding-backed) suites.
//
// These use FakeEmbeddingProvider: deterministic bag-of-words hash vectors where shared words ⇒ high
// cosine. Every threshold below was chosen against numerically verified cosine/word-overlap values for
// the exact test strings (noted inline), with comfortable margins. Thresholds are injected via DI
// (constructor opts) so no test depends on the env-var defaults.
// ---------------------------------------------------------------------------

/** Semantic stores created via makeSemanticStore(), closed automatically after each test. */
const semanticStores: MemoryStore[] = [];

afterEach(() => {
  for (const s of semanticStores) {
    // @ts-expect-error accessing private db for cleanup
    s.db.close();
  }
  semanticStores.length = 0;
});

/** Creates a MemoryStore backed by a FakeEmbeddingProvider, registered for automatic cleanup. */
function makeSemanticStore(
  opts: {
    relevanceThreshold?: number;
    dedupThreshold?: number;
    ttls?: Record<string, number>;
    fake?: FakeEmbeddingProvider;
  } = {},
): { store: MemoryStore; fake: FakeEmbeddingProvider } {
  const fake = opts.fake ?? new FakeEmbeddingProvider();
  const semanticStore = new MemoryStore(':memory:', {
    embeddings: fake,
    relevanceThreshold: opts.relevanceThreshold,
    dedupThreshold: opts.dedupThreshold,
    ttls: opts.ttls,
  });
  semanticStores.push(semanticStore);
  return { store: semanticStore, fake };
}

/** Cosine the fake embedder produces between a query string and a memory's stored document text. */
function fakeCosine(query: string, memory: { subject: string; content: string }): number {
  return cosineSimilarity(
    FakeEmbeddingProvider.vectorFor(query),
    FakeEmbeddingProvider.vectorFor(buildEmbeddingInput(memory)),
  );
}

/** Cosine the fake embedder produces between two memories' stored document texts. */
function fakeDocCosine(a: { subject: string; content: string }, b: { subject: string; content: string }): number {
  return cosineSimilarity(
    FakeEmbeddingProvider.vectorFor(buildEmbeddingInput(a)),
    FakeEmbeddingProvider.vectorFor(buildEmbeddingInput(b)),
  );
}

/** Counts memory_embeddings rows (optionally for one memory id) via private db access. */
function countVectorRows(s: MemoryStore, memoryId?: number): number {
  // @ts-expect-error accessing private db for verification
  const db = s.db;
  const row =
    memoryId === undefined
      ? (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as { n: number })
      : (db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?').get(memoryId) as { n: number });
  return row.n;
}

/** Reads the stored input_text for a memory's vector row, or undefined when it has no vector. */
function getVectorInputText(s: MemoryStore, memoryId: number): string | undefined {
  // @ts-expect-error accessing private db for verification
  const db = s.db;
  const row = db.prepare('SELECT input_text FROM memory_embeddings WHERE memory_id = ?').get(memoryId) as
    | { input_text: string }
    | undefined;
  return row?.input_text;
}

/** A fake that runs a one-shot callback at the start of the next embed() call (mid-backfill mutation tests). */
class CallbackFakeEmbeddingProvider extends FakeEmbeddingProvider {
  onNextEmbed?: () => Promise<void>;

  override async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    if (this.onNextEmbed) {
      const callback = this.onNextEmbed;
      this.onNextEmbed = undefined;
      await callback();
    }
    return super.embed(texts, kind);
  }
}

/** A fake that fails specific (1-based) embed calls, counted from the last resetCallCount(). */
class FailNthCallFakeEmbeddingProvider extends FakeEmbeddingProvider {
  failOnCalls = new Set<number>();
  private callCount = 0;

  resetCallCount(): void {
    this.callCount = 0;
  }

  override async embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]> {
    this.callCount++;
    if (this.failOnCalls.has(this.callCount)) {
      throw new Error(`simulated failure on call ${this.callCount}`);
    }
    return super.embed(texts, kind);
  }
}

describe('semantic search (hybrid vector + FTS)', () => {
  it('finds memories by meaning when FTS keyword search misses', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.3 });
    const pizzaMemory = { category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' };
    const id = await semStore.save(pizzaMemory);
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });

    // Precondition (verified value 0.5774): the query is semantically close to the pizza memory.
    expect(fakeCosine('felix favorite pizza', pizzaMemory)).toBeGreaterThan(0.3);

    // FTS AND-semantics misses: 'favorite' appears in no memory. Prove it on a legacy (embedder-less)
    // store holding identical data — this is exactly the query class the semantic upgrade exists for.
    await store.save(pizzaMemory);
    expect(await store.search('felix favorite pizza')).toEqual([]);

    const results = await semStore.search('felix favorite pizza');
    expect(results.map((m) => m.id)).toEqual([id]);
  });

  it('ranks results by semantic similarity and gates out unrelated memories', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.3 });
    const idPizza = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const idPasta = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pasta' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });

    // Verified cosines vs the query: pizza 0.5963, pasta 0.5477, league 0.1240 (below the 0.3 gate).
    // No memory contains 'likes', so the FTS leg is empty and the order is pure vector ranking.
    const results = await semStore.search('felix likes pizza and pasta');

    expect(results.map((m) => m.id)).toEqual([idPizza, idPasta]);
  });

  it('boosts a memory found by both legs above a higher-cosine vector-only memory (RRF fusion)', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.3 });
    const bothLegsMemory = {
      category: 'fact',
      subject: 'Felix',
      content: 'Felix hobby photography lessons every Saturday morning downtown',
    };
    const vectorOnlyMemory = { category: 'fact', subject: 'Felix', content: 'Felix hobby' };
    const idBoth = await semStore.save(bothLegsMemory);
    const idVectorOnly = await semStore.save(vectorOnlyMemory);

    // Preconditions (verified: 0.7746 vs 0.6963): the vector-only memory is semantically CLOSER to the
    // query, but only bothLegsMemory contains every query keyword (so only it gets the FTS-leg boost).
    const query = 'felix hobby photography';
    expect(fakeCosine(query, vectorOnlyMemory)).toBeGreaterThan(fakeCosine(query, bothLegsMemory));
    expect(fakeCosine(query, bothLegsMemory)).toBeGreaterThan(0.3);

    const results = await semStore.search(query);

    // RRF: (vector rank 2 + FTS rank 1) outranks (vector rank 1 + no FTS hit).
    expect(results.map((m) => m.id)).toEqual([idBoth, idVectorOnly]);
  });
});

describe('semantic gate (anti-pollution rule)', () => {
  it('drops FTS keyword hits whose cosine is below the relevance threshold', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.4 });
    const linkMemory = {
      category: 'fact',
      subject: 'Felix',
      content: 'Felix shared a link about cooking pasta recipes yesterday evening',
    };
    await semStore.save(linkMemory);

    // Precondition (verified value 0.2774): 'pasta' IS a keyword hit but is below the 0.4 gate.
    expect(fakeCosine('pasta', linkMemory)).toBeLessThan(0.4);

    // Legacy FTS (embedder-less store) would return it...
    await store.save(linkMemory);
    expect(await store.search('pasta')).toHaveLength(1);

    // ...the gated semantic store does not.
    expect(await semStore.search('pasta')).toEqual([]);
  });

  it('drops keyword hits on un-embedded memories once coverage reaches the 80% gate threshold', async () => {
    const { store: semStore, fake } = makeSemanticStore({ relevanceThreshold: 0.3 });

    // 1 of 5 memories saved during an outage → vector coverage 4/5 = exactly 80% (the gate boundary).
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix went kayaking last weekend' });
    fake.failWith = undefined;
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    await semStore.save({ category: 'fact', subject: 'Alex', content: 'Alex collects vintage vinyl records' });
    await semStore.save({ category: 'fact', subject: 'Sam', content: 'Sam runs marathons every spring season' });

    // FTS finds the kayaking memory by keyword, but it has no vector → no computable cosine → dropped.
    // Keyword hits on un-embedded memories can never pollute gated results.
    expect(await semStore.search('kayaking')).toEqual([]);
  });
});

describe('save-time semantic dedup', () => {
  it('merges a semantic near-duplicate into the EXISTING memory id', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65, relevanceThreshold: 0.3 });
    const original = { category: 'fact', subject: 'Felix', content: 'Felix loves eating pizza with extra cheese on top' };
    const paraphrase = { category: 'fact', subject: 'Felix', content: 'Felix loves eating pizza with mushrooms' };

    // Preconditions (verified: overlap 0.5714, cosine 0.8018): lexical dedup misses, semantic dedup hits.
    expect(wordOverlap(original.content, paraphrase.content)).toBeLessThanOrEqual(0.6);
    expect(fakeDocCosine(original, paraphrase)).toBeGreaterThanOrEqual(0.65);

    const originalId = await semStore.save(original);
    const returnedId = await semStore.save(paraphrase);

    // The OLD id survives with the new content (ids are user-visible via recall_memories/forget_memory).
    expect(returnedId).toBe(originalId);
    const active = semStore.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(originalId);
    expect(active[0].content).toBe(paraphrase.content);

    // Exactly one memory row and one vector row remain; the vector reflects the new content.
    expect(countVectorRows(semStore)).toBe(1);
    expect(getVectorInputText(semStore, originalId)).toBe(buildEmbeddingInput(paraphrase));
  });

  it('keeps semantically distinct memories as separate rows', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });
    const pizza = { category: 'fact', subject: 'Felix', content: 'Felix loves eating pizza with extra cheese on top' };
    const job = { category: 'fact', subject: 'Felix', content: 'Felix works as a software engineer at a bank' };

    // Precondition (verified value 0.4286): well below the dedup threshold.
    expect(fakeDocCosine(pizza, job)).toBeLessThan(0.65);

    const id1 = await semStore.save(pizza);
    const id2 = await semStore.save(job);

    expect(id2).not.toBe(id1);
    expect(semStore.getAllActive()).toHaveLength(2);
    expect(countVectorRows(semStore)).toBe(2);
  });

  it('never merges across different subjects even at near-duplicate cosine', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });
    const felixVersion = { category: 'fact', subject: 'Felix', content: 'Felix loves eating pizza with extra cheese on top' };
    const alexVersion = { category: 'fact', subject: 'Alex', content: 'Felix loves eating pizza with extra cheese on top' };

    // Precondition (verified value 0.9258): far above the threshold — only subject scoping keeps them apart.
    expect(fakeDocCosine(felixVersion, alexVersion)).toBeGreaterThan(0.65);

    const id1 = await semStore.save(felixVersion);
    const id2 = await semStore.save(alexVersion);

    expect(id2).not.toBe(id1);
    expect(semStore.getAllActive()).toHaveLength(2);
  });

  it('never merges across different categories even for identical text', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });
    const asFact = { category: 'fact', subject: 'Felix', content: 'Felix loves eating pizza with extra cheese on top' };
    const asPreference = {
      category: 'preference',
      subject: 'Felix',
      content: 'Felix loves eating pizza with extra cheese on top',
    };

    // Identical embedding input → cosine 1.0 — only category scoping keeps them apart.
    expect(fakeDocCosine(asFact, asPreference)).toBeCloseTo(1, 5);

    const id1 = await semStore.save(asFact);
    const id2 = await semStore.save(asPreference);

    expect(id2).not.toBe(id1);
    expect(semStore.getAllActive()).toHaveLength(2);
  });

  it('refreshes the stored vector when a lexical (word-overlap) merge updates content', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    const original = { category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' };
    const updated = { category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' };

    const id = await semStore.save(original);
    expect(getVectorInputText(semStore, id)).toBe(buildEmbeddingInput(original));

    // Word overlap 0.8 > 0.6 → phase-1 lexical merge keeps the id; phase 2 must re-embed the new text.
    const mergedId = await semStore.save(updated);

    expect(mergedId).toBe(id);
    expect(getVectorInputText(semStore, id)).toBe(buildEmbeddingInput(updated));
    expect(countVectorRows(semStore)).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['document', 'document']);
  });
});

describe('search fallbacks (embedding failure / low vector coverage)', () => {
  it('save() persists the memory even when embedding fails', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('embeddings API down');

    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });

    expect(id).toBeGreaterThan(0);
    expect(semStore.getAllActive()).toHaveLength(1);
    // No vector was stored — the backfill heals this later.
    expect(countVectorRows(semStore)).toBe(0);
  });

  it('search() falls back to ungated FTS when the query embed fails', async () => {
    const { store: semStore, fake } = makeSemanticStore({ relevanceThreshold: 0.4 });
    // This memory's cosine vs the query 'pasta' is 0.2774 — below the 0.4 gate.
    await semStore.save({
      category: 'fact',
      subject: 'Felix',
      content: 'Felix shared a link about cooking pasta recipes yesterday evening',
    });

    // Gated search drops it...
    expect(await semStore.search('pasta')).toEqual([]);

    // ...but when the query embed fails, search degrades to ungated FTS and returns it.
    fake.failWith = new Error('embeddings API down');
    const results = await semStore.search('pasta');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('pasta');
  });

  it('search() falls back to ungated FTS when vector coverage is below 80%', async () => {
    const { store: semStore, fake } = makeSemanticStore({ relevanceThreshold: 0.3 });

    // 4 of 5 memories saved during an outage → vector coverage 1/5 = 20%.
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix went kayaking last weekend' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    await semStore.save({ category: 'fact', subject: 'Alex', content: 'Alex collects vintage vinyl records' });
    await semStore.save({ category: 'fact', subject: 'Sam', content: 'Sam runs marathons every spring season' });
    fake.failWith = undefined;
    await semStore.save({ category: 'fact', subject: 'Pat', content: 'Pat bakes sourdough bread weekly' });

    // The kayaking memory has no vector, so gated search would drop it — but with coverage this low the
    // gate disengages (hiding the un-embedded majority would be worse) and ungated FTS returns it.
    const results = await semStore.search('kayaking');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('kayaking');
  });

  it('search() on an empty semantic store returns [] without errors', async () => {
    const { store: semStore } = makeSemanticStore();
    expect(await semStore.search('anything at all')).toEqual([]);
  });

  it('returns [] for empty, whitespace, or punctuation-only queries without calling the embeddings API', async () => {
    const { store: semStore, fake } = makeSemanticStore({ relevanceThreshold: 0.3 });
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const callsBefore = fake.calls.length;

    expect(await semStore.search('')).toEqual([]);
    expect(await semStore.search('   ')).toEqual([]);
    expect(await semStore.search(',,,')).toEqual([]);

    // The contract with teeth: queries that sanitize to nothing must never trigger a (paid) embed call.
    // In prod the real provider wraps queries in the qwen3 instruct prefix, so embedding a blank query
    // produces a non-zero vector that can pull arbitrary memories over the gate — the guard prevents that.
    expect(fake.calls.length).toBe(callsBefore);
  });

  it('reads MEMORY_RELEVANCE_THRESHOLD from env when no threshold is injected', async () => {
    vi.stubEnv('MEMORY_RELEVANCE_THRESHOLD', '0.99');
    try {
      // No DI threshold → constructor falls back to the env var.
      const { store: semStore } = makeSemanticStore();
      await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });

      // Cosine 0.5774 < 0.99 → gated out under the env-provided threshold.
      expect(await semStore.search('felix favorite pizza')).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('vector storage lifecycle and integrity', () => {
  it('deactivate() deletes the stored vectors of the memory', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    expect(countVectorRows(semStore, id)).toBe(1);

    semStore.deactivate(id);

    expect(countVectorRows(semStore, id)).toBe(0);
  });

  it('remove() deletes the stored vectors of the memory', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    expect(countVectorRows(semStore, id)).toBe(1);

    semStore.remove(id);

    expect(countVectorRows(semStore, id)).toBe(0);
  });

  it('stores vectors that decode back to the exact embedded vector (round-trip integrity)', async () => {
    const { store: semStore } = makeSemanticStore();
    const memory = { category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' };
    const id = await semStore.save(memory);

    // @ts-expect-error accessing private db for verification
    const db = semStore.db;
    const row = db.prepare('SELECT dims, vector FROM memory_embeddings WHERE memory_id = ?').get(id) as {
      dims: number;
      vector: Buffer;
    };

    const expected = FakeEmbeddingProvider.vectorFor(buildEmbeddingInput(memory));
    expect(row.dims).toBe(expected.length);
    expect(Array.from(blobToVector(row.vector))).toEqual(Array.from(expected));
  });

  it('rejects vector blobs whose byte length does not match dims (CHECK constraint)', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const vec = FakeEmbeddingProvider.vectorFor('some text'); // 128 dims → 512-byte blob

    // @ts-expect-error accessing private db to attempt corrupt inserts
    const db = semStore.db;
    const insert = db.prepare(
      'INSERT INTO memory_embeddings (memory_id, model, dims, input_text, vector) VALUES (?, ?, ?, ?, ?)',
    );

    // dims claims 256 but the blob holds 128 floats → rejected.
    expect(() => insert.run(id, 'other-model-a', 256, 'some text', vectorToBlob(vec))).toThrow(/CHECK constraint/i);
    // dims = 0 → rejected.
    expect(() => insert.run(id, 'other-model-b', 0, 'some text', vectorToBlob(vec))).toThrow(/CHECK constraint/i);
    // Sanity: a consistent insert under a different model is accepted.
    expect(() => insert.run(id, 'other-model-c', vec.length, 'some text', vectorToBlob(vec))).not.toThrow();
  });
});

describe('backfillEmbeddings()', () => {
  it('embeds active memories that lack vectors and makes them semantically searchable', async () => {
    const { store: semStore, fake } = makeSemanticStore({ relevanceThreshold: 0.3 });

    fake.failWith = new Error('outage');
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    fake.failWith = undefined;

    // Un-embedded and not keyword-matchable → invisible to search.
    expect(await semStore.search('felix favorite pizza')).toEqual([]);

    const result = await semStore.backfillEmbeddings();

    expect(result).toEqual({ embedded: 2, reembedded: 0, failed: 0 });
    expect(countVectorRows(semStore)).toBe(2);
    // Semantic recall now works for the healed memories.
    expect((await semStore.search('felix favorite pizza')).map((m) => m.id)).toEqual([id]);
  });

  it('is idempotent: a second run embeds nothing and makes no API calls', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    fake.failWith = undefined;

    // Only the vector-less memory gets embedded; the already-embedded one is untouched.
    const first = await semStore.backfillEmbeddings();
    expect(first).toEqual({ embedded: 1, reembedded: 0, failed: 0 });

    const callsAfterFirst = fake.calls.length;
    const second = await semStore.backfillEmbeddings();
    expect(second).toEqual({ embedded: 0, reembedded: 0, failed: 0 });
    expect(fake.calls.length).toBe(callsAfterFirst);
  });

  it('returns zero counts when no embedding provider is configured', async () => {
    // The file-level legacy store has no embedder.
    await store.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    expect(await store.backfillEmbeddings()).toEqual({ embedded: 0, reembedded: 0, failed: 0 });
  });

  it('counts failed batches and heals them on the next run', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });

    // The API is still down during the backfill itself.
    const failedRun = await semStore.backfillEmbeddings();
    expect(failedRun).toEqual({ embedded: 0, reembedded: 0, failed: 2 });
    expect(countVectorRows(semStore)).toBe(0);

    // API recovers → the next run heals everything.
    fake.failWith = undefined;
    const healedRun = await semStore.backfillEmbeddings();
    expect(healedRun).toEqual({ embedded: 2, reembedded: 0, failed: 0 });
    expect(countVectorRows(semStore)).toBe(2);
  });

  it('processes memories in batches of the requested size', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    await semStore.save({ category: 'fact', subject: 'Alex', content: 'Alex collects vintage vinyl records' });
    fake.failWith = undefined;
    const callsBefore = fake.calls.length;

    const result = await semStore.backfillEmbeddings(2);

    expect(result).toEqual({ embedded: 3, reembedded: 0, failed: 0 });
    // 3 memories at batch size 2 → two API calls: 2 texts then 1 text, all as documents.
    const backfillCalls = fake.calls.slice(callsBefore);
    expect(backfillCalls.map((c) => c.texts.length)).toEqual([2, 1]);
    expect(backfillCalls.every((c) => c.kind === 'document')).toBe(true);
  });

  it('isolates batch failures: one failing batch does not abort the rest', async () => {
    const fake = new FailNthCallFakeEmbeddingProvider();
    const { store: semStore } = makeSemanticStore({ fake });
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    await semStore.save({ category: 'fact', subject: 'Alex', content: 'Alex collects vintage vinyl records' });
    fake.failWith = undefined;

    // Fail the first backfill batch only.
    fake.resetCallCount();
    fake.failOnCalls = new Set([1]);

    const result = await semStore.backfillEmbeddings(2);

    // Batch 1 (2 memories) failed and is counted; batch 2 (1 memory) still succeeded.
    expect(result).toEqual({ embedded: 1, reembedded: 0, failed: 2 });
    expect(countVectorRows(semStore)).toBe(1);
  });

  it('re-embeds and prunes old-model vectors after a model switch (expand-contract)', async () => {
    const fake = new FakeEmbeddingProvider('fake-model-v1');
    const { store: semStore } = makeSemanticStore({ fake, relevanceThreshold: 0.3 });

    const id1 = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const id2 = await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });

    // The store reads the provider's model at call time, so mutating the fake simulates an
    // EMBEDDING_MODEL change without restarting (same DB, new model string).
    (fake as { model: string }).model = 'fake-model-v2';

    const result = await semStore.backfillEmbeddings();
    expect(result).toEqual({ embedded: 0, reembedded: 2, failed: 0 });

    // Expand-contract complete: each memory has exactly one vector, all under the new model.
    // @ts-expect-error accessing private db for verification
    const db = semStore.db;
    const rows = db.prepare('SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id').all() as {
      memory_id: number;
      model: string;
    }[];
    expect(rows).toEqual([
      { memory_id: id1, model: 'fake-model-v2' },
      { memory_id: id2, model: 'fake-model-v2' },
    ]);

    // And search works under the new model.
    expect((await semStore.search('felix favorite pizza')).map((m) => m.id)).toEqual([id1]);
  });

  it('prevents overlapping runs: a concurrent backfill is a no-op (in-flight guard)', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    await semStore.save({ category: 'fact', subject: 'Alex', content: 'Alex collects vintage vinyl records' });
    fake.failWith = undefined;
    const callsBefore = fake.calls.length;

    const [first, second] = await Promise.all([semStore.backfillEmbeddings(), semStore.backfillEmbeddings()]);

    // The first call does the work; the second sees the in-flight flag and returns immediately.
    expect(first).toEqual({ embedded: 3, reembedded: 0, failed: 0 });
    expect(second).toEqual({ embedded: 0, reembedded: 0, failed: 0 });
    // Only one embed call total (a single batch of 3) — no duplicated API spend.
    expect(fake.calls.length - callsBefore).toBe(1);
    expect(countVectorRows(semStore)).toBe(3);
  });

  it('does not overwrite a fresher vector with a stale one (content changed mid-backfill)', async () => {
    const fake = new CallbackFakeEmbeddingProvider();
    const { store: semStore } = makeSemanticStore({ fake });

    // A memory saved during an outage: no vector yet.
    fake.failWith = new Error('outage');
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix lives in Toronto Canada downtown' });
    fake.failWith = undefined;

    // While the backfill awaits the embeddings API, a concurrent save() updates the same memory
    // (word overlap 0.8 → lexical merge keeps the id) and embeds the NEW content itself.
    const updated = { category: 'fact', subject: 'Felix', content: 'Felix lives in Montreal Canada downtown' };
    fake.onNextEmbed = async () => {
      await semStore.save(updated);
    };

    const result = await semStore.backfillEmbeddings();

    // The backfill must skip its now-stale row instead of clobbering the fresher vector.
    expect(result).toEqual({ embedded: 0, reembedded: 0, failed: 0 });
    expect(getVectorInputText(semStore, id)).toBe(buildEmbeddingInput(updated));
    expect(semStore.getAllActive().find((m) => m.id === id)?.content).toBe(updated.content);
  });

  it('skips deactivated memories', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    const idKeep = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const idGone = await semStore.save({ category: 'fact', subject: 'Jason', content: 'Jason plays League of Legends ranked' });
    fake.failWith = undefined;
    semStore.deactivate(idGone);

    const result = await semStore.backfillEmbeddings();

    expect(result).toEqual({ embedded: 1, reembedded: 0, failed: 0 });
    expect(countVectorRows(semStore, idKeep)).toBe(1);
    expect(countVectorRows(semStore, idGone)).toBe(0);
  });

  it('embeds searchable memories before self-diagnosis memories', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    // Saved first (older), but self-diagnosis → embedded last.
    await semStore.save({ category: 'tool_error', subject: 'bot', content: 'Image generation failed badly' });
    await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    fake.failWith = undefined;
    const callsBefore = fake.calls.length;

    // Batch size 1 → one call per memory, in priority order.
    await semStore.backfillEmbeddings(1);

    const backfillCalls = fake.calls.slice(callsBefore);
    expect(backfillCalls.map((c) => c.texts[0])).toEqual([
      'Felix: Felix loves pizza and hot dogs',
      'bot: Image generation failed badly',
    ]);
  });
});

describe('compact() with stored vectors', () => {
  it('deactivates semantic duplicates using stored vectors (no API calls)', async () => {
    const { store: semStore, fake } = makeSemanticStore({ dedupThreshold: 0.65, relevanceThreshold: 0.3 });

    // Two same-(category,subject) memories saved during an outage: word overlap 0.5714 ≤ 0.6 keeps them
    // as separate rows, and neither has a vector yet.
    fake.failWith = new Error('outage');
    const idOlder = await semStore.save({
      category: 'fact',
      subject: 'Felix',
      content: 'Felix loves eating pizza with extra cheese on top',
    });
    const idNewer = await semStore.save({
      category: 'fact',
      subject: 'Felix',
      content: 'Felix loves eating pizza with mushrooms',
    });
    fake.failWith = undefined;
    expect(idNewer).not.toBe(idOlder);

    // Make recency deterministic (both saves landed within the same second).
    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare("UPDATE memories SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(idOlder);

    // Heal vectors, then compact: cosine 0.8018 ≥ 0.65 → duplicates → older one deactivated.
    await semStore.backfillEmbeddings();
    const callsBeforeCompact = fake.calls.length;
    const result = semStore.compact();

    expect(result.removed).toBe(1);
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([idNewer]);
    // The deactivated duplicate's vectors are cleaned up; the survivor keeps its vector.
    expect(countVectorRows(semStore, idOlder)).toBe(0);
    expect(countVectorRows(semStore, idNewer)).toBe(1);
    // compact() is synchronous and never calls the embeddings API.
    expect(fake.calls.length).toBe(callsBeforeCompact);
  });

  it('trusts vectors over word overlap when vectors exist (no false dedup)', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });

    // Two genuinely different memories — both get vectors encoding these contents at save time.
    const idA = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const idB = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix enjoys watching anime shows' });

    // A raw edit makes their CONTENTS overlap 0.8333 (the lexical rule would call them duplicates), but
    // their stored VECTORS still encode the original distinct meanings (cosine 0.4714 < 0.65).
    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Felix loves pizza and hot dogs indeed', idB);

    const result = semStore.compact();

    // With vectors present the semantic comparison is authoritative: not duplicates.
    expect(result.removed).toBe(0);
    expect(semStore.getAllActive().map((m) => m.id).sort()).toEqual([idA, idB].sort());
  });

  it('falls back to word overlap for memories without vectors', async () => {
    const { store: semStore, fake } = makeSemanticStore({ dedupThreshold: 0.65 });

    // Same shape as the test above, but vectors never exist (outage at save, no backfill run).
    fake.failWith = new Error('outage');
    const idA = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    const idB = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix enjoys watching anime shows' });
    fake.failWith = undefined;

    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Felix loves pizza and hot dogs indeed', idB);
    db.prepare("UPDATE memories SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(idA);

    const result = semStore.compact();

    // No vectors → the word-overlap fallback applies → 0.8333 > 0.6 → duplicates → older deactivated.
    expect(result.removed).toBe(1);
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([idB]);
  });

  it('sweeps orphaned vector rows', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix loves pizza and hot dogs' });
    semStore.deactivate(id); // also deletes its vectors
    expect(countVectorRows(semStore)).toBe(0);

    // Simulate a historical orphan (e.g. predating vector cleanup) via raw SQL: a vector row pointing at
    // the deactivated memory.
    const orphanVec = FakeEmbeddingProvider.vectorFor('orphan text');
    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare('INSERT INTO memory_embeddings (memory_id, model, dims, input_text, vector) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'fake-embeddings',
      orphanVec.length,
      'orphan text',
      vectorToBlob(orphanVec),
    );
    // @ts-expect-error calling private invalidateVectorCache: raw SQL bypassed the write-through cache
    semStore.invalidateVectorCache();
    expect(countVectorRows(semStore)).toBe(1);

    semStore.compact();

    expect(countVectorRows(semStore)).toBe(0);
  });
});

describe('ephemeral memory TTL (sweepExpiredMemories)', () => {
  /**
   * Ages a memory by rewinding BOTH updated_at and created_at via raw SQL.
   * NOTE: SQLite date modifiers are single-unit only — '-24 hours -1 seconds' silently produces NULL —
   * so offsets near a boundary must be expressed in a single unit (e.g. '-86401 seconds' for 24h + 1s).
   */
  function ageMemory(s: MemoryStore, id: number, modifier: string): void {
    // @ts-expect-error accessing private db for test setup
    const db = s.db;
    db.prepare("UPDATE memories SET updated_at = datetime('now', ?), created_at = datetime('now', ?) WHERE id = ?").run(
      modifier,
      modifier,
      id,
    );
  }

  it('expires image memories past their TTL and reports the count', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24, event: 336 } });
    const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-25 hours');

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });
    expect(semStore.getAllActive()).toEqual([]);
  });

  it('keeps memories within their TTL and expires them once past it (boundary bracket)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const keptId = await semStore.save({ category: 'image', subject: 'Felix', content: 'Shared a cat picture from the shelter' });
    const expiredId = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });

    // The exact-second boundary (contract: strict <, exactly-TTL is kept) cannot be asserted
    // deterministically against a moving clock, so these margins bracket it to within 61 seconds:
    ageMemory(semStore, keptId, '-86340 seconds'); // 23h59m old → within TTL → kept
    ageMemory(semStore, expiredId, '-86401 seconds'); // 24h + 1s old → past TTL → expired

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([keptId]);
  });

  it('expires event memories after their own TTL (14 days, independent of the image TTL)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24, event: 336 } });
    const keptId = await semStore.save({ category: 'event', subject: 'server', content: 'Game night planned for Friday' });
    const expiredId = await semStore.save({ category: 'event', subject: 'server', content: 'Costco run and barbecue on Sunday' });

    ageMemory(semStore, keptId, '-1209540 seconds'); // 336h - 60s → within TTL → kept
    ageMemory(semStore, expiredId, '-1209601 seconds'); // 336h + 1s → past TTL → expired

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([keptId]);
  });

  it('never expires non-ephemeral categories regardless of age', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24, event: 336 } });
    const ids = [
      await semStore.save({ category: 'fact', subject: 'Felix', content: 'Felix works as a software engineer' }),
      await semStore.save({ category: 'preference', subject: 'Felix', content: 'Felix prefers tea over coffee' }),
      await semStore.save({ category: 'personality', subject: 'Jason', content: 'Jason has dry sarcastic humor' }),
      await semStore.save({ category: 'vibe', subject: 'server', content: 'Server loves absurdist in-jokes' }),
      await semStore.save({ category: 'tool_error', subject: 'bot', content: 'Image generation failed once' }),
    ];
    for (const id of ids) ageMemory(semStore, id, '-87600 hours'); // ~10 years

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
    expect(semStore.getAllActive()).toHaveLength(5);
  });

  it('is idempotent: a second sweep expires nothing', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id1 = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
    const id2 = await semStore.save({ category: 'image', subject: 'Felix', content: 'Shared a cat picture from the shelter' });
    ageMemory(semStore, id1, '-25 hours');
    ageMemory(semStore, id2, '-25 hours');

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 2 });
    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
  });

  it('expiry removes the memory from semantic search, FTS, and the vector store', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 }, relevanceThreshold: 0.3 });
    const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked anxiety' });

    // Findable everywhere before expiry.
    expect(countVectorRows(semStore, id)).toBe(1);
    expect((await semStore.search('league meme')).map((m) => m.id)).toEqual([id]);
    expect(semStore.getBySubject('Jason')).toHaveLength(1);

    ageMemory(semStore, id, '-25 hours');
    semStore.sweepExpiredMemories();

    // Invisible everywhere after expiry — vectors, FTS, and subject lookup all cleaned.
    expect(countVectorRows(semStore, id)).toBe(0);
    expect(await semStore.search('league meme')).toEqual([]);
    expect(semStore.getBySubject('Jason')).toEqual([]);
  });

  it('a dedup-merge re-observation refreshes the TTL clock (updated_at, not created_at)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked anxiety' });

    // The memory is past its TTL (both timestamps aged)...
    ageMemory(semStore, id, '-25 hours');

    // ...but the same image gets re-observed before any sweep runs: lexical dedup (overlap 0.857)
    // merges into the same id and refreshes updated_at to now. created_at stays 25 hours old.
    const mergedId = await semStore.save({
      category: 'image',
      subject: 'Jason',
      content: 'Shared a meme about League ranked anxiety again',
    });
    expect(mergedId).toBe(id);

    // The sweep keys on updated_at → the re-observed memory is fresh again ("retrieved ephemerally").
    // If the clock were created_at (still 25h old), this would expire — that's the discriminating case.
    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([id]);
  });

  it('an expired memory does not block re-observation (new row, fresh TTL)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 }, dedupThreshold: 0.65 });
    const content = 'Shared a meme about League ranked anxiety';
    const originalId = await semStore.save({ category: 'image', subject: 'Jason', content });
    ageMemory(semStore, originalId, '-25 hours');
    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });

    // The identical observation arrives again later: neither lexical nor semantic dedup may resurrect
    // the expired row — it gets a brand-new id and a fresh TTL window.
    const newId = await semStore.save({ category: 'image', subject: 'Jason', content });

    expect(newId).not.toBe(originalId);
    const active = semStore.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(newId);
  });

  it('ttls: {} disables all expiry (DI replaces the defaults entirely)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: {} });
    const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-87600 hours'); // ~10 years

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
    expect(semStore.getAllActive()).toHaveLength(1);
  });

  it('a DI TTL of 0 disables expiry for that category only', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 0, event: 336 } });
    const imageId = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
    const eventId = await semStore.save({ category: 'event', subject: 'server', content: 'Game night planned for Friday' });
    ageMemory(semStore, imageId, '-87600 hours');
    ageMemory(semStore, eventId, '-87600 hours');

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([imageId]);
  });

  it('reads MEMORY_TTL_IMAGE_HOURS and MEMORY_TTL_EVENT_DAYS from env when no ttls are injected', async () => {
    vi.stubEnv('MEMORY_TTL_IMAGE_HOURS', '1'); // 1 hour
    vi.stubEnv('MEMORY_TTL_EVENT_DAYS', '1'); // 1 day = 24 hours
    try {
      const { store: semStore } = makeSemanticStore(); // no ttls DI → env values apply
      const imageId = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
      const eventId = await semStore.save({ category: 'event', subject: 'server', content: 'Game night planned for Friday' });
      ageMemory(semStore, imageId, '-3660 seconds'); // 1h + 60s → past the 1-hour image TTL
      ageMemory(semStore, eventId, '-86460 seconds'); // 24h + 60s → past the 1-day event TTL

      expect(semStore.sweepExpiredMemories()).toEqual({ expired: 2 });
      expect(semStore.getAllActive()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an env TTL of 0 disables expiry for that category', async () => {
    vi.stubEnv('MEMORY_TTL_IMAGE_HOURS', '0');
    try {
      const { store: semStore } = makeSemanticStore();
      const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
      ageMemory(semStore, id, '-87600 hours'); // ~10 years

      expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
      expect(semStore.getAllActive()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('compact() runs the TTL sweep first and reports expired counts', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id = await semStore.save({ category: 'image', subject: 'Jason', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-25 hours');

    const result = semStore.compact();

    expect(result).toEqual({ removed: 0, expired: 1 });
    expect(semStore.getAllActive()).toEqual([]);
  });
});
