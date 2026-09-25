import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
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
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it('save() stores source as "conversation" by default', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('conversation');
  });

  it('save() stores custom source when provided', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats', source: 'observation' });
    const all = store.getAllActive();
    const mem = all.find((m) => m.id === id);
    expect(mem?.source).toBe('observation');
  });

  it('getAllActive() returns empty array on fresh store', () => {
    expect(store.getAllActive()).toEqual([]);
  });

  it('getAllActive() excludes deactivated memories', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
  });

  it('getBySubject() filters by exact subject', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    await store.save({ category: 'fact', subject: 'Alex', content: 'Likes dogs' });
    const results = store.getBySubject('Remi');
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('Remi');
  });

  it('getBySubject() respects limit param', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    await store.save({ category: 'preference', subject: 'Remi', content: 'Prefers tea' });
    await store.save({ category: 'fact', subject: 'Remi', content: 'Lives in Toronto' });
    const results = store.getBySubject('Remi', 2);
    expect(results).toHaveLength(2);
  });

  it('getBySubject() excludes inactive', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getBySubject('Remi')).toEqual([]);
  });

  it('getByCategory() filters by category', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    await store.save({ category: 'preference', subject: 'Remi', content: 'Prefers tea' });
    const results = store.getByCategory('fact');
    expect(results).toHaveLength(1);
    expect(results[0].category).toBe('fact');
  });

});

describe('FTS5 search', () => {
  it('search() matches message-length queries on any keyword (partial tier), not only when every word matches', async () => {
    // Regression: the keyword leg used to AND every query term, so a whole chat message as the query
    // matched nothing — the FTS-only fallback returned [] for any real message.
    await store.save({ category: 'fact', subject: 'Remi', content: 'Drives a red Miata' });
    await store.save({ category: 'fact', subject: 'Jasper', content: 'Plays League ranked' });
    const results = await store.search('what does remi drive these days');
    expect(results.map((m) => m.content)).toEqual(['Drives a red Miata']);
  });

  it('search() ranks a memory matching every term above one matching some terms', async () => {
    await store.save({ category: 'fact', subject: 'A', content: 'apple picking trip planned' });
    await store.save({ category: 'fact', subject: 'B', content: 'apple pie recipe' });
    const results = await store.search('apple picking');
    expect(results.map((m) => m.subject)).toEqual(['A', 'B']);
  });

  it('search() ignores stop words in the partial tier', async () => {
    await store.save({ category: 'fact', subject: 'A', content: 'the weather is nice' });
    // Every query term is a stop word except one that matches nothing → no partial hits.
    expect(await store.search('is it the dinosaurs')).toEqual([]);
  });

  it('search() finds by content keyword', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Loves programming in TypeScript' });
    const results = await store.search('TypeScript');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('search() finds by subject', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    const results = await store.search('Remi');
    expect(results).toHaveLength(1);
  });

  it('search() returns only active memories', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
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
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    expect(await store.search('dinosaurs')).toEqual([]);
  });

  it('search() stays in sync after deactivate', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('search() stays in sync after remove', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes pangolins' });
    store.remove(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('search() handles commas in query', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi likes cats' });
    const results = await store.search('Remi, cats');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('cats');
  });

  it('search() handles quotes in query', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi has a nickname' });
    const results = await store.search('Remi "nickname"');
    expect(results).toHaveLength(1);
  });

  it('search() handles parentheses in query', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi likes cats' });
    const results = await store.search('(Remi)');
    expect(results).toHaveLength(1);
  });

  it('search() returns empty for query that is all special characters', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi likes cats' });
    const results = await store.search(',,,');
    expect(results).toEqual([]);
  });

  it('search() handles mixed valid and special chars', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi has cats and dogs' });
    const results = await store.search("Remi's cats, dogs");
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Remi');
  });
});

describe('dedup on save (word overlap)', () => {
  it('updates existing row when same category+subject and >60% word overlap', async () => {
    const id1 = await store.save({
      category: 'fact',
      subject: 'Remi',
      content: 'Remi lives in Toronto Canada downtown',
    });
    const id2 = await store.save({
      category: 'fact',
      subject: 'Remi',
      content: 'Remi lives in Montreal Canada downtown',
    });
    expect(id2).toBe(id1);
    const all = store.getAllActive();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('Remi lives in Montreal Canada downtown');
  });

  it('creates a new row when overlap <= 60%', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Remi', content: 'Works as a plumber downtown' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different subjects', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats very much indeed' });
    const id2 = await store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('does NOT dedup across different categories', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats very much indeed' });
    const id2 = await store.save({ category: 'preference', subject: 'Remi', content: 'Likes cats very much indeed' });
    expect(id2).not.toBe(id1);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('FTS index reflects updated content after dedup merge', async () => {
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi lives in Toronto Canada downtown' });
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi lives in Montreal Canada downtown' });
    // Old content should not be findable
    expect(await store.search('Toronto')).toEqual([]);
    // New content should be findable
    expect(await store.search('Montreal')).toHaveLength(1);
  });

  it('does NOT dedup against deactivated memories', async () => {
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Remi lives in Toronto Canada downtown' });
    store.deactivate(id1);
    const id2 = await store.save({ category: 'fact', subject: 'Remi', content: 'Remi lives in Montreal Canada downtown' });
    expect(id2).not.toBe(id1);
  });
});

describe('deactivate() and remove()', () => {
  it('deactivate() sets active=0 and memory disappears from active queries', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    store.deactivate(id);
    expect(store.getAllActive()).toEqual([]);
    expect(store.getBySubject('Remi')).toEqual([]);
  });

  it('deactivate() removes from FTS index', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes pangolins' });
    store.deactivate(id);
    expect(await store.search('pangolins')).toEqual([]);
  });

  it('deactivate() is a no-op for nonexistent ids', () => {
    expect(() => store.deactivate(999)).not.toThrow();
  });

  it('remove() permanently deletes the row', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });
    store.remove(id);
    expect(store.getAllActive()).toEqual([]);
    // @ts-expect-error accessing private db to verify row is gone
    const row = store.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
  });

  it('remove() removes from FTS index', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes pangolins' });
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
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats and dogs very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Remi', content: 'Enjoys swimming every weekend morning' });
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
    const id1 = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats and dogs very much' });
    const id2 = await store.save({ category: 'fact', subject: 'Remi', content: 'Enjoys swimming every weekend morning' });

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
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats and dogs very much' });
    await store.save({ category: 'fact', subject: 'Alex', content: 'Likes cats and dogs very much' });
    await store.save({ category: 'preference', subject: 'Remi', content: 'Likes cats and dogs very much' });

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
    await store.save({ category: 'fact', subject: 'Remi', content: 'Likes cats' });

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

describe('bot_state (generic key/value)', () => {
  it('getState() returns undefined for an unknown key', () => {
    expect(store.getState('digest:last_run_at')).toBeUndefined();
  });

  it('setState() + getState() round-trips', () => {
    store.setState('digest:last_run_at', '2026-06-12T00:00:00.000Z');
    expect(store.getState('digest:last_run_at')).toBe('2026-06-12T00:00:00.000Z');
  });

  it('setState() overwrites in place (upsert, no duplicate rows)', () => {
    store.setState('deploy:last_announced_sha', 'aaaaaaa');
    store.setState('deploy:last_announced_sha', 'bbbbbbb');
    expect(store.getState('deploy:last_announced_sha')).toBe('bbbbbbb');

    // @ts-expect-error accessing private db for verification
    const rows = store.db.prepare('SELECT * FROM bot_state WHERE key = ?').all('deploy:last_announced_sha');
    expect(rows).toHaveLength(1);
  });

  it('setState() refreshes updated_at on overwrite', () => {
    store.setState('digest:last_run_at', 'v1');
    // datetime('now') only has 1s resolution, so two rapid writes could share a timestamp. Force a
    // known-old value first, then prove the overwrite moves updated_at forward.
    // @ts-expect-error accessing private db for test setup
    store.db.prepare('UPDATE bot_state SET updated_at = ? WHERE key = ?').run('2000-01-01 00:00:00', 'digest:last_run_at');

    store.setState('digest:last_run_at', 'v2');

    // @ts-expect-error accessing private db for verification
    const row = store.db.prepare('SELECT updated_at FROM bot_state WHERE key = ?').get('digest:last_run_at') as {
      updated_at: string;
    };
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });
});

describe('subject_user_id (soft-FK to identities)', () => {
  it('save() defaults subject_user_id to null when omitted', async () => {
    const id = await store.save({ category: 'fact', subject: 'Wheelie', content: 'Likes cats' });
    const row = store.getAllActive().find((m) => m.id === id);
    expect(row?.subject_user_id).toBeNull();
  });

  it('save() persists subject_user_id when provided', async () => {
    const id = await store.save({
      category: 'fact',
      subject: 'Wheelie',
      content: 'Likes cats',
      subject_user_id: '123',
    });
    const row = store.getAllActive().find((m) => m.id === id);
    expect(row?.subject_user_id).toBe('123');
  });

  it('getForPerson() matches the stable id and every known name, newest first', async () => {
    await store.save({ category: 'fact', subject: 'OldNick', content: 'Plays bass', subject_user_id: '123' });
    await store.save({ category: 'fact', subject: 'Wheelie', content: 'Owns a husky' });
    await store.save({ category: 'fact', subject: 'Someone Else', content: 'Hates cilantro' });
    const rows = store.getForPerson({ userId: '123', names: ['Wheelie', ' ', 'Wheelie'] });
    expect(rows.map((r) => r.content).sort()).toEqual(['Owns a husky', 'Plays bass']);
  });

  it('getForPerson() with neither an id nor a name returns nothing', () => {
    expect(store.getForPerson({ names: [] })).toEqual([]);
  });

  it("getForPerson() never claims another member's id-stamped row through a shared name", async () => {
    // Member 111 is displayed as "Alex"; member 222's IRL name or nickname is also "Alex".
    await store.save({ category: 'fact', subject: 'Alex', content: 'Works at the depot', subject_user_id: '111' });
    await store.save({ category: 'fact', subject: 'Alex', content: 'Played hockey as a kid' });
    await store.save({ category: 'fact', subject: 'Sam', content: 'Collects vinyl', subject_user_id: '222' });

    const forSam = store.getForPerson({ userId: '222', names: ['Sam', 'Alex'] }).map((m) => m.content);
    expect(forSam.sort()).toEqual(['Collects vinyl', 'Played hockey as a kid']);

    const forAlex = store.getForPerson({ userId: '111', names: ['Alex'] }).map((m) => m.content);
    expect(forAlex.sort()).toEqual(['Played hockey as a kid', 'Works at the depot']);

    // A name-only lookup (no id known) still takes every row filed under the name.
    expect(store.getForPerson({ names: ['Alex'] })).toHaveLength(2);
  });
});

describe('identities', () => {
  it('getIdentityById() returns undefined for unknown IDs', () => {
    expect(store.getIdentityById('unknown-id')).toBeUndefined();
  });

  it('upsertIdentity() creates a new row with canonical_name equal to display_name', () => {
    store.upsertIdentity('123', 'Wheelie');
    const identity = store.getIdentityById('123');
    expect(identity).toBeDefined();
    expect(identity?.display_name).toBe('Wheelie');
    expect(identity?.canonical_name).toBe('Wheelie');
    expect(identity?.irl_name).toBeNull();
    expect(identity?.aliases).toEqual([]);
  });

  it('upsertIdentity() updates display_name but preserves canonical_name on rename', () => {
    store.upsertIdentity('123', 'Wheelie');
    store.upsertIdentity('123', 'wheelieboy2');

    const identity = store.getIdentityById('123');
    expect(identity?.display_name).toBe('wheelieboy2');
    expect(identity?.canonical_name).toBe('Wheelie');
  });

  it('upsertIdentity() is idempotent when display_name unchanged', () => {
    store.upsertIdentity('123', 'Wheelie');
    const first = store.getIdentityById('123');
    const firstUpdated = first?.updated_at;

    // Same name — should not bump updated_at
    store.upsertIdentity('123', 'Wheelie');
    const second = store.getIdentityById('123');
    expect(second?.updated_at).toBe(firstUpdated);
  });

  it('updateIdentityMeta() returns false for unknown IDs', () => {
    expect(store.updateIdentityMeta('unknown-id', { irl_name: 'Ghost' })).toBe(false);
  });

  it('updateIdentityMeta() sets irl_name on a known identity', () => {
    store.upsertIdentity('123', 'Wheelie');
    const changed = store.updateIdentityMeta('123', { irl_name: 'Dorian' });
    expect(changed).toBe(true);
    expect(store.getIdentityById('123')?.irl_name).toBe('Dorian');
  });

  it('updateIdentityMeta() returns false when irl_name is identical', () => {
    store.upsertIdentity('123', 'Wheelie');
    store.updateIdentityMeta('123', { irl_name: 'Dorian' });
    expect(store.updateIdentityMeta('123', { irl_name: 'Dorian' })).toBe(false);
  });

  it('updateIdentityMeta() ignores empty irl_name strings', () => {
    store.upsertIdentity('123', 'Wheelie');
    const changed = store.updateIdentityMeta('123', { irl_name: '   ' });
    expect(changed).toBe(false);
    expect(store.getIdentityById('123')?.irl_name).toBeNull();
  });

  it('updateIdentityMeta() appends aliases and dedupes', () => {
    store.upsertIdentity('123', 'Wheelie');

    store.updateIdentityMeta('123', { aliases_add: ['Dory', 'D'] });
    expect(store.getIdentityById('123')?.aliases).toEqual(['Dory', 'D']);

    // Duplicate alias should not re-append
    const changed = store.updateIdentityMeta('123', { aliases_add: ['Dory', 'D-man'] });
    expect(changed).toBe(true);
    expect(store.getIdentityById('123')?.aliases).toEqual(['Dory', 'D', 'D-man']);
  });

  it('updateIdentityMeta() returns false when no meaningful aliases are added', () => {
    store.upsertIdentity('123', 'Wheelie');
    store.updateIdentityMeta('123', { aliases_add: ['Dory'] });
    expect(store.updateIdentityMeta('123', { aliases_add: ['Dory'] })).toBe(false);
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
    store.updateIdentityMeta('1', { aliases_add: ['Agathe', 'A'] });

    const [identity] = store.getAllIdentities();
    expect(identity.aliases).toEqual(['Agathe', 'A']);
  });

  it('upsertIdentity() records the Discord handle, keeps it when a caller has none, and follows a change', () => {
    store.upsertIdentity('123', 'Jasper');
    expect(store.getIdentityById('123')?.username).toBeNull();

    store.upsertIdentity('123', 'Jasper', 'lapinlune');
    expect(store.getIdentityById('123')?.username).toBe('lapinlune');

    // Fetched history / relays only know a name: the handle survives.
    store.upsertIdentity('123', 'Jay', '  ');
    store.upsertIdentity('123', 'Jay');
    expect(store.getIdentityById('123')).toMatchObject({ display_name: 'Jay', username: 'lapinlune' });

    store.upsertIdentity('123', 'Jay', 'lapin2');
    expect(store.getIdentityById('123')?.username).toBe('lapin2');
  });

  it('upsertIdentity() bumps updated_at when only the handle changes', () => {
    store.upsertIdentity('123', 'Jasper', 'old_handle');
    // @ts-expect-error accessing private db for test setup
    store.db.prepare("UPDATE identities SET updated_at = datetime('now', '-1 day') WHERE discord_user_id = '123'").run();
    const before = store.getIdentityById('123')?.updated_at;

    store.upsertIdentity('123', 'Jasper', 'old_handle');
    expect(store.getIdentityById('123')?.updated_at).toBe(before);

    store.upsertIdentity('123', 'Jasper', 'new_handle');
    expect(store.getIdentityById('123')?.updated_at).not.toBe(before);
  });

  it('adds the username column to an existing identities table (additive migration)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migration-'));
    const file = path.join(dir, 'memory.db');
    try {
      const legacy = new Database(file);
      legacy.exec(`CREATE TABLE identities (
        discord_user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, canonical_name TEXT NOT NULL, irl_name TEXT,
        aliases TEXT NOT NULL DEFAULT '[]', first_seen_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')), active INTEGER DEFAULT 1)`);
      legacy.prepare("INSERT INTO identities (discord_user_id, display_name, canonical_name) VALUES ('1', 'Jasper', 'Jasper')").run();
      legacy.close();

      const migrated = new MemoryStore(file);
      expect(migrated.getIdentityById('1')).toMatchObject({ display_name: 'Jasper', username: null });
      migrated.upsertIdentity('1', 'Jasper', 'lapinlune');
      expect(migrated.getIdentityById('1')?.username).toBe('lapinlune');
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    const pizzaMemory = { category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' };
    const id = await semStore.save(pizzaMemory);
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });

    // Precondition (verified value 0.5774): the query is semantically close to the pizza memory.
    expect(fakeCosine('remi favorite pizza', pizzaMemory)).toBeGreaterThan(0.3);

    // No memory contains every query word ('favorite' appears nowhere), so the exact keyword tier is
    // empty; the semantic leg is what carries this query class.
    const results = await semStore.search('remi favorite pizza');
    expect(results.map((m) => m.id)).toEqual([id]);
  });

  it('ranks results by semantic similarity and gates out unrelated memories', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.3 });
    const idPizza = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    const idPasta = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pasta' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });

    // Verified cosines vs the query: pizza 0.5963, pasta 0.5477, league 0.1240 (below the 0.3 gate).
    // No memory contains 'likes', so the FTS leg is empty and the order is pure vector ranking.
    const results = await semStore.search('remi likes pizza and pasta');

    expect(results.map((m) => m.id)).toEqual([idPizza, idPasta]);
  });

  it('boosts a memory found by both legs above a higher-cosine vector-only memory (RRF fusion)', async () => {
    const { store: semStore } = makeSemanticStore({ relevanceThreshold: 0.3 });
    const bothLegsMemory = {
      category: 'fact',
      subject: 'Remi',
      content: 'Remi hobby photography lessons every Saturday morning downtown',
    };
    const vectorOnlyMemory = { category: 'fact', subject: 'Remi', content: 'Remi hobby' };
    const idBoth = await semStore.save(bothLegsMemory);
    const idVectorOnly = await semStore.save(vectorOnlyMemory);

    // Preconditions (verified: 0.7746 vs 0.6963): the vector-only memory is semantically CLOSER to the
    // query, but only bothLegsMemory contains every query keyword (so only it gets the FTS-leg boost).
    const query = 'remi hobby photography';
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
      subject: 'Remi',
      content: 'Remi shared a link about cooking pasta recipes yesterday evening',
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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi went kayaking last weekend' });
    fake.failWith = undefined;
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    const original = { category: 'fact', subject: 'Remi', content: 'Remi loves eating pizza with extra cheese on top' };
    const paraphrase = { category: 'fact', subject: 'Remi', content: 'Remi loves eating pizza with mushrooms' };

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
    const pizza = { category: 'fact', subject: 'Remi', content: 'Remi loves eating pizza with extra cheese on top' };
    const job = { category: 'fact', subject: 'Remi', content: 'Remi works as a software engineer at a bank' };

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
    const remiVersion = { category: 'fact', subject: 'Remi', content: 'Remi loves eating pizza with extra cheese on top' };
    const alexVersion = { category: 'fact', subject: 'Alex', content: 'Remi loves eating pizza with extra cheese on top' };

    // Precondition (verified value 0.9258): far above the threshold — only subject scoping keeps them apart.
    expect(fakeDocCosine(remiVersion, alexVersion)).toBeGreaterThan(0.65);

    const id1 = await semStore.save(remiVersion);
    const id2 = await semStore.save(alexVersion);

    expect(id2).not.toBe(id1);
    expect(semStore.getAllActive()).toHaveLength(2);
  });

  it('never merges across different categories even for identical text', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });
    const asFact = { category: 'fact', subject: 'Remi', content: 'Remi loves eating pizza with extra cheese on top' };
    const asPreference = {
      category: 'preference',
      subject: 'Remi',
      content: 'Remi loves eating pizza with extra cheese on top',
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
    const original = { category: 'fact', subject: 'Remi', content: 'Remi lives in Toronto Canada downtown' };
    const updated = { category: 'fact', subject: 'Remi', content: 'Remi lives in Montreal Canada downtown' };

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

    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });

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
      subject: 'Remi',
      content: 'Remi shared a link about cooking pasta recipes yesterday evening',
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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi went kayaking last weekend' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
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
      await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });

      // Cosine 0.5774 < 0.99 → gated out under the env-provided threshold.
      expect(await semStore.search('remi favorite pizza')).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('vector storage lifecycle and integrity', () => {
  it('deactivate() deletes the stored vectors of the memory', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    expect(countVectorRows(semStore, id)).toBe(1);

    semStore.deactivate(id);

    expect(countVectorRows(semStore, id)).toBe(0);
  });

  it('remove() deletes the stored vectors of the memory', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    expect(countVectorRows(semStore, id)).toBe(1);

    semStore.remove(id);

    expect(countVectorRows(semStore, id)).toBe(0);
  });

  it('stores vectors that decode back to the exact embedded vector (round-trip integrity)', async () => {
    const { store: semStore } = makeSemanticStore();
    const memory = { category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' };
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
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
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
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
    fake.failWith = undefined;

    // Before the backfill nothing has a vector, so search runs in ungated keyword mode: a query that
    // shares no word with the memory can't find it (this is the query class embeddings exist for).
    expect(await semStore.search('favourite italian food')).toEqual([]);

    const result = await semStore.backfillEmbeddings();

    expect(result).toEqual({ embedded: 2, reembedded: 0, failed: 0 });
    expect(countVectorRows(semStore)).toBe(2);
    // Semantic recall now works for the healed memories.
    expect((await semStore.search('remi favorite pizza')).map((m) => m.id)).toEqual([id]);
  });

  it('is idempotent: a second run embeds nothing and makes no API calls', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    await store.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    expect(await store.backfillEmbeddings()).toEqual({ embedded: 0, reembedded: 0, failed: 0 });
  });

  it('counts failed batches and heals them on the next run', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });

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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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

    const id1 = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    const id2 = await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });

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
    expect((await semStore.search('remi favorite pizza')).map((m) => m.id)).toEqual([id1]);
  });

  it('prevents overlapping runs: a concurrent backfill is a no-op (in-flight guard)', async () => {
    const { store: semStore, fake } = makeSemanticStore();
    fake.failWith = new Error('outage');
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi lives in Toronto Canada downtown' });
    fake.failWith = undefined;

    // While the backfill awaits the embeddings API, a concurrent save() updates the same memory
    // (word overlap 0.8 → lexical merge keeps the id) and embeds the NEW content itself.
    const updated = { category: 'fact', subject: 'Remi', content: 'Remi lives in Montreal Canada downtown' };
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
    const idKeep = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    const idGone = await semStore.save({ category: 'fact', subject: 'Jasper', content: 'Jasper plays League of Legends ranked' });
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
    await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    fake.failWith = undefined;
    const callsBefore = fake.calls.length;

    // Batch size 1 → one call per memory, in priority order.
    await semStore.backfillEmbeddings(1);

    const backfillCalls = fake.calls.slice(callsBefore);
    expect(backfillCalls.map((c) => c.texts[0])).toEqual([
      'Remi: Remi loves pizza and hot dogs',
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
      subject: 'Remi',
      content: 'Remi loves eating pizza with extra cheese on top',
    });
    const idNewer = await semStore.save({
      category: 'fact',
      subject: 'Remi',
      content: 'Remi loves eating pizza with mushrooms',
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
    const idA = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    const idB = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi enjoys watching anime shows' });

    // A raw edit makes their CONTENTS overlap 0.8333 (the lexical rule would call them duplicates), but
    // their stored VECTORS still encode the original distinct meanings (cosine 0.4714 < 0.65).
    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Remi loves pizza and hot dogs indeed', idB);

    const result = semStore.compact();

    // With vectors present the semantic comparison is authoritative: not duplicates.
    expect(result.removed).toBe(0);
    expect(semStore.getAllActive().map((m) => m.id).sort()).toEqual([idA, idB].sort());
  });

  it('falls back to word overlap for memories without vectors', async () => {
    const { store: semStore, fake } = makeSemanticStore({ dedupThreshold: 0.65 });

    // Same shape as the test above, but vectors never exist (outage at save, no backfill run).
    fake.failWith = new Error('outage');
    const idA = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
    const idB = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi enjoys watching anime shows' });
    fake.failWith = undefined;

    // @ts-expect-error accessing private db for test setup
    const db = semStore.db;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Remi loves pizza and hot dogs indeed', idB);
    db.prepare("UPDATE memories SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(idA);

    const result = semStore.compact();

    // No vectors → the word-overlap fallback applies → 0.8333 > 0.6 → duplicates → older deactivated.
    expect(result.removed).toBe(1);
    expect(semStore.getAllActive().map((m) => m.id)).toEqual([idB]);
  });

  it('sweeps orphaned vector rows', async () => {
    const { store: semStore } = makeSemanticStore();
    const id = await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi loves pizza and hot dogs' });
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
    const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-25 hours');

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });
    expect(semStore.getAllActive()).toEqual([]);
  });

  it('keeps memories within their TTL and expires them once past it (boundary bracket)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const keptId = await semStore.save({ category: 'image', subject: 'Remi', content: 'Shared a cat picture from the shelter' });
    const expiredId = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });

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
      await semStore.save({ category: 'fact', subject: 'Remi', content: 'Remi works as a software engineer' }),
      await semStore.save({ category: 'preference', subject: 'Remi', content: 'Remi prefers tea over coffee' }),
      await semStore.save({ category: 'personality', subject: 'Jasper', content: 'Jasper has dry sarcastic humor' }),
      await semStore.save({ category: 'vibe', subject: 'server', content: 'Server loves absurdist in-jokes' }),
      await semStore.save({ category: 'tool_error', subject: 'bot', content: 'Image generation failed once' }),
    ];
    for (const id of ids) ageMemory(semStore, id, '-87600 hours'); // ~10 years

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
    expect(semStore.getAllActive()).toHaveLength(5);
  });

  it('is idempotent: a second sweep expires nothing', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id1 = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
    const id2 = await semStore.save({ category: 'image', subject: 'Remi', content: 'Shared a cat picture from the shelter' });
    ageMemory(semStore, id1, '-25 hours');
    ageMemory(semStore, id2, '-25 hours');

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 2 });
    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
  });

  it('expiry removes the memory from semantic search, FTS, and the vector store', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 }, relevanceThreshold: 0.3 });
    const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked anxiety' });

    // Findable everywhere before expiry.
    expect(countVectorRows(semStore, id)).toBe(1);
    expect((await semStore.search('league meme')).map((m) => m.id)).toEqual([id]);
    expect(semStore.getBySubject('Jasper')).toHaveLength(1);

    ageMemory(semStore, id, '-25 hours');
    semStore.sweepExpiredMemories();

    // Invisible everywhere after expiry — vectors, FTS, and subject lookup all cleaned.
    expect(countVectorRows(semStore, id)).toBe(0);
    expect(await semStore.search('league meme')).toEqual([]);
    expect(semStore.getBySubject('Jasper')).toEqual([]);
  });

  it('a dedup-merge re-observation refreshes the TTL clock (updated_at, not created_at)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked anxiety' });

    // The memory is past its TTL (both timestamps aged)...
    ageMemory(semStore, id, '-25 hours');

    // ...but the same image gets re-observed before any sweep runs: lexical dedup (overlap 0.857)
    // merges into the same id and refreshes updated_at to now. created_at stays 25 hours old.
    const mergedId = await semStore.save({
      category: 'image',
      subject: 'Jasper',
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
    const originalId = await semStore.save({ category: 'image', subject: 'Jasper', content });
    ageMemory(semStore, originalId, '-25 hours');
    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 1 });

    // The identical observation arrives again later: neither lexical nor semantic dedup may resurrect
    // the expired row — it gets a brand-new id and a fresh TTL window.
    const newId = await semStore.save({ category: 'image', subject: 'Jasper', content });

    expect(newId).not.toBe(originalId);
    const active = semStore.getAllActive();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(newId);
  });

  it('ttls: {} disables all expiry (DI replaces the defaults entirely)', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: {} });
    const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-87600 hours'); // ~10 years

    expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
    expect(semStore.getAllActive()).toHaveLength(1);
  });

  it('a DI TTL of 0 disables expiry for that category only', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 0, event: 336 } });
    const imageId = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
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
      const imageId = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
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
      const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
      ageMemory(semStore, id, '-87600 hours'); // ~10 years

      expect(semStore.sweepExpiredMemories()).toEqual({ expired: 0 });
      expect(semStore.getAllActive()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('compact() runs the TTL sweep first and reports expired counts', async () => {
    const { store: semStore } = makeSemanticStore({ ttls: { image: 24 } });
    const id = await semStore.save({ category: 'image', subject: 'Jasper', content: 'Shared a meme about League ranked' });
    ageMemory(semStore, id, '-25 hours');

    const result = semStore.compact();

    expect(result).toEqual({ removed: 0, expired: 1 });
    expect(semStore.getAllActive()).toEqual([]);
  });
});

describe('deactivate() idempotence and FTS index integrity', () => {
  it('deactivate() returns true once and false on a repeat call', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Likes pangolins' });
    expect(store.deactivate(id)).toBe(true);
    expect(store.deactivate(id)).toBe(false);
    expect(store.deactivate(999_999)).toBe(false);
  });

  it('a repeated deactivate() does not corrupt the FTS index (regression: "database disk image is malformed")', async () => {
    const keep = await store.save({ category: 'fact', subject: 'Remi', content: 'Collects vintage synthesizers' });
    const gone = await store.save({ category: 'fact', subject: 'Jasper', content: 'Likes pangolins' });

    store.deactivate(gone);
    store.deactivate(gone); // the model calling forget_memory twice with the same id

    // Every later MATCH used to throw once the external-content index was corrupted.
    const results = await store.search('synthesizers');
    expect(results.map((m) => m.id)).toEqual([keep]);
  });

  it('compact() survives a three-way duplicate group and leaves the index searchable', async () => {
    // Three mutual duplicates: the old i/j loop deactivated the third one twice (once against each of
    // the others), corrupting the index.
    const a = await store.save({ category: 'fact', subject: 'Remi', content: 'Enjoys swimming every weekend morning' });
    const b = await store.save({ category: 'fact', subject: 'Remi', content: 'Collects rare stamps from Europe' });
    const c = await store.save({ category: 'fact', subject: 'Remi', content: 'Reads science fiction novels nightly' });
    const jasper = await store.save({ category: 'fact', subject: 'Jasper', content: 'Plays League of Legends ranked' });
    // @ts-expect-error accessing private db for test setup
    const db = store.db;
    db.prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed' WHERE id = ?").run(a);
    db.prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed too', updated_at = datetime('now', '-1 hour') WHERE id = ?").run(b);
    db.prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed also', updated_at = datetime('now', '-2 hours') WHERE id = ?").run(c);

    const result = store.compact();

    expect(result.removed).toBe(2);
    expect(store.getAllActive().map((m) => m.id).sort((x, y) => x - y)).toEqual([a, jasper]);
    const results = await store.search('League');
    expect(results).toHaveLength(1);
  });

  it('rebuildFtsIndex() restores a searchable index from the active rows', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Brews kombucha at home' });
    const inactive = await store.save({ category: 'fact', subject: 'Jasper', content: 'Drinks kombucha daily' });
    store.deactivate(inactive);

    // Simulate a corrupted / stale index: wipe it behind the store's back.
    // @ts-expect-error accessing private db for test setup
    store.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");
    expect(await store.search('kombucha')).toEqual([]);

    expect(store.rebuildFtsIndex()).toBe(1);

    const results = await store.search('kombucha');
    expect(results.map((m) => m.id)).toEqual([id]);
  });

  it('compact() rebuilds the index, so a corrupted index heals on the next startup', async () => {
    const id = await store.save({ category: 'fact', subject: 'Remi', content: 'Restores old arcade cabinets' });
    // @ts-expect-error accessing private db for test setup
    store.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");

    store.compact();

    expect((await store.search('arcade')).map((m) => m.id)).toEqual([id]);
  });
});

describe('stampSubjectUserIds() (startup link of name-only memories to member ids)', () => {
  function rowOf(id: number) {
    // @ts-expect-error accessing private db for verification
    return store.db.prepare('SELECT subject, subject_user_id, updated_at, active FROM memories WHERE id = ?').get(id) as {
      subject: string;
      subject_user_id: string | null;
      updated_at: string;
      active: number;
    };
  }

  beforeEach(() => {
    store.upsertIdentity('111', 'OldNick');
    store.upsertIdentity('111', 'Wheelie'); // display Wheelie, canonical OldNick
    store.upsertIdentity('222', 'Jasper');
  });

  it('stamps rows whose subject is a member’s current or first-seen name, case-insensitively', async () => {
    const a = await store.save({ category: 'fact', subject: 'Wheelie', content: 'Owns a husky' });
    const b = await store.save({ category: 'fact', subject: 'oldnick', content: 'Plays bass guitar' });
    const c = await store.save({ category: 'fact', subject: 'JASPER', content: 'Works nights at the depot' });

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 3, relinked: 0, names: 3, ambiguous: 0 });
    expect(rowOf(a).subject_user_id).toBe('111');
    expect(rowOf(b).subject_user_id).toBe('111');
    expect(rowOf(c).subject_user_id).toBe('222');
    // Subjects are left as written (the FTS index covers them); getForPerson now finds every row by id.
    expect(rowOf(b).subject).toBe('oldnick');
    expect(store.getForPerson({ userId: '111', names: [] }).map((m) => m.id).sort()).toEqual([a, b].sort());
  });

  it('also stamps Discord handles, IRL names and nicknames that only one member goes by', async () => {
    store.upsertIdentity('222', 'Jasper', 'lapinlune');
    store.updateIdentityMeta('111', { irl_name: 'Dorian', aliases_add: ['Wheels'] });
    const handle = await store.save({ category: 'fact', subject: 'lapinlune', content: 'Mains Jhin in ranked' });
    const irl = await store.save({ category: 'fact', subject: 'Dorian', content: 'Works as an electrician' });
    const alias = await store.save({ category: 'preference', subject: 'wheels', content: 'Hates cilantro' });

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 3, relinked: 0, names: 3, ambiguous: 0 });
    expect(rowOf(handle).subject_user_id).toBe('222');
    expect(rowOf(irl).subject_user_id).toBe('111');
    expect(rowOf(alias).subject_user_id).toBe('111');
  });

  it('treats a name two members go by in any form as ambiguous (a display name does not outrank a nickname here)', async () => {
    store.updateIdentityMeta('111', { aliases_add: ['Jasper'] });
    const row = await store.save({ category: 'fact', subject: 'Jasper', content: 'Drives a red Miata' });

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 0, relinked: 0, names: 0, ambiguous: 1 });
    expect(rowOf(row).subject_user_id).toBeNull();
  });

  it("is idempotent and never overwrites a known member's id", async () => {
    store.upsertIdentity('999', 'Silas');
    const mismatched = await store.save({ category: 'fact', subject: 'Jasper', subject_user_id: '999', content: 'Has a twin' });
    await store.save({ category: 'fact', subject: 'Jasper', content: 'Drives a red Miata' });

    expect(store.stampSubjectUserIds().stamped).toBe(1);
    expect(store.stampSubjectUserIds()).toEqual({ stamped: 0, relinked: 0, names: 0, ambiguous: 0 });
    expect(rowOf(mismatched).subject_user_id).toBe('999');
  });

  it('treats an id no member has (copied from a prompt example, garbled) like no id', async () => {
    // The old learner stored whatever id the model wrote.
    const copied = await store.save({ category: 'fact', subject: 'Jasper', subject_user_id: '456', content: 'Still plays on PS4' });
    const stranger = await store.save({ category: 'fact', subject: 'Stranger', subject_user_id: '456', content: 'Lives in Laval' });
    // An inactive identity (a member who left) is still somebody: their rows keep their id.
    store.upsertIdentity('444', 'Wheelie');
    // @ts-expect-error accessing private db for test setup
    store.db.prepare("UPDATE identities SET active = 0 WHERE discord_user_id = '444'").run();
    const departed = await store.save({ category: 'fact', subject: 'Jasper', subject_user_id: '444', content: 'Moved to Calgary' });
    expect(store.getForPerson({ userId: '222', names: ['Jasper'] }).map((m) => m.id)).toEqual([]);

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 1, relinked: 0, names: 1, ambiguous: 0 });
    expect(rowOf(copied).subject_user_id).toBe('222');
    expect(rowOf(stranger).subject_user_id).toBe('456');
    expect(rowOf(departed).subject_user_id).toBe('444');
    expect(store.getForPerson({ userId: '222', names: ['Jasper'] }).map((m) => m.id)).toEqual([copied]);
    expect(store.stampSubjectUserIds().stamped).toBe(0);
  });

  it('skips names shared by two members, server-wide subjects, unknown names and inactive rows', async () => {
    // Someone else was first seen as "Wheelie" too: the name is ambiguous.
    store.upsertIdentity('333', 'Wheelie');
    store.upsertIdentity('333', 'Silas');
    const ambiguous = await store.save({ category: 'fact', subject: 'Wheelie', content: 'Likes cats a lot' });
    const server = await store.save({ category: 'vibe', subject: 'server', content: 'Movie night on Fridays' });
    const unknown = await store.save({ category: 'fact', subject: 'Stranger', content: 'Nobody knows them' });
    const inactive = await store.save({ category: 'fact', subject: 'Jasper', content: 'Used to skate' });
    store.deactivate(inactive);

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 0, relinked: 0, names: 0, ambiguous: 1 });
    for (const id of [ambiguous, server, unknown, inactive]) expect(rowOf(id).subject_user_id).toBeNull();
  });

  it('does not refresh updated_at (the TTL clock) or disturb search', async () => {
    const id = await store.save({ category: 'event', subject: 'Jasper', content: 'Moving apartments next week' });
    // @ts-expect-error accessing private db for test setup
    store.db.prepare("UPDATE memories SET updated_at = datetime('now', '-3 days') WHERE id = ?").run(id);
    const before = rowOf(id).updated_at;

    store.stampSubjectUserIds();

    expect(rowOf(id).updated_at).toBe(before);
    expect((await store.search('apartments')).map((m) => m.id)).toEqual([id]);
  });
});

describe('stampSubjectUserIds() with linked side accounts (LINKED_ACCOUNTS)', () => {
  // Fake ids only: a main account and the side account the same person sometimes posts from.
  const MAIN = '100000000000000001';
  const SIDE = '100000000000000002';
  const OTHER = '100000000000000003';

  function idOf(id: number): string | null {
    // @ts-expect-error accessing private db for verification
    return (store.db.prepare('SELECT subject_user_id FROM memories WHERE id = ?').get(id) as { subject_user_id: string | null })
      .subject_user_id;
  }

  beforeEach(() => {
    vi.stubEnv('LINKED_ACCOUNTS', `${SIDE}:${MAIN}`);
    store.upsertIdentity(MAIN, 'Toby', 'toby_main');
    store.upsertIdentity(SIDE, 'Tohbee', 'tobyclone');
    store.upsertIdentity(OTHER, 'Silas');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps rows filed under a side account's names with the main account's id", async () => {
    const byDisplay = await store.save({ category: 'fact', subject: 'Tohbee', content: 'Collects vinyl records' });
    const byHandle = await store.save({ category: 'fact', subject: 'tobyclone', content: 'Mains support in Overwatch' });

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 2, relinked: 0, names: 2, ambiguous: 0 });
    expect(idOf(byDisplay)).toBe(MAIN);
    expect(idOf(byHandle)).toBe(MAIN);
  });

  it('treats a name the main and the side account share as one person, not an ambiguity', async () => {
    store.upsertIdentity(SIDE, 'Toby', 'tobyclone');
    const row = await store.save({ category: 'fact', subject: 'toby', content: 'Works at the hardware store' });

    expect(store.stampSubjectUserIds()).toEqual({ stamped: 1, relinked: 0, names: 1, ambiguous: 0 });
    expect(idOf(row)).toBe(MAIN);
  });

  it("moves rows already stamped with the side account's id to the main account", async () => {
    const row = await store.save({ category: 'fact', subject: 'Tohbee', subject_user_id: SIDE, content: 'Hates pineapple pizza' });
    const other = await store.save({ category: 'fact', subject: 'Silas', subject_user_id: OTHER, content: 'Lives in Montreal' });

    expect(store.stampSubjectUserIds().relinked).toBe(1);
    expect(idOf(row)).toBe(MAIN);
    expect(idOf(other)).toBe(OTHER);
    expect(store.stampSubjectUserIds().relinked).toBe(0);
  });

  it('lets compact() dedup the side and main rows on the same start when it runs after the stamp', async () => {
    await store.save({ category: 'fact', subject: 'Toby', subject_user_id: MAIN, content: 'Owns a black lab named Moose' });
    await store.save({ category: 'fact', subject: 'Tohbee', content: 'Owns a black lab named Moose' });

    store.stampSubjectUserIds();
    const { removed } = store.compact();

    expect(removed).toBe(1);
    expect(store.getAllActive().filter((m) => m.content.includes('Moose'))).toHaveLength(1);
  });

  it("getForPerson() by the main id also finds rows keyed on the side account's id", async () => {
    const row = await store.save({ category: 'fact', subject: 'Tohbee', subject_user_id: SIDE, content: 'Plays the cello' });

    expect(store.getForPerson({ userId: MAIN, names: [] }).map((m) => m.id)).toEqual([row]);
    expect(store.getForPerson({ userId: SIDE, names: [] }).map((m) => m.id)).toEqual([row]);
  });
});

describe('save-time dedup never merges two different people who share a name', () => {
  it('lexical dedup skips a row with another member id, and a merge adopts the incoming id', async () => {
    const first = await store.save({ category: 'fact', subject: 'Alex', subject_user_id: '111', content: 'Likes cats and dogs very much' });
    const other = await store.save({ category: 'fact', subject: 'Alex', subject_user_id: '222', content: 'Likes cats and dogs very much indeed' });
    expect(other).not.toBe(first);

    const nameOnly = await store.save({ category: 'fact', subject: 'Sam', content: 'Plays the drums every weekend' });
    const merged = await store.save({ category: 'fact', subject: 'Sam', subject_user_id: '333', content: 'Plays the drums every weekend now' });
    expect(merged).toBe(nameOnly);
    expect(store.getAllActive().find((m) => m.id === nameOnly)?.subject_user_id).toBe('333');
  });

  it('semantic dedup skips a near-duplicate that belongs to another member id', async () => {
    const { store: semStore } = makeSemanticStore({ dedupThreshold: 0.65 });
    // Word overlap 0.5714 (≤ 0.6, lexical keeps both) but cosine ≈ 0.80 (≥ 0.65, semantic would merge).
    const a = await semStore.save({ category: 'fact', subject: 'Alex', subject_user_id: '111', content: 'Alex loves eating pizza with extra cheese on top' });
    const b = await semStore.save({ category: 'fact', subject: 'Alex', subject_user_id: '222', content: 'Alex loves eating pizza with mushrooms' });
    expect(b).not.toBe(a);
    expect(semStore.getAllActive()).toHaveLength(2);

    const c = await semStore.save({ category: 'fact', subject: 'Alex', subject_user_id: '111', content: 'Alex loves eating pizza with mushrooms' });
    expect(c).toBe(a);
  });
});

describe('compact() dedup groups by person (subject_user_id, else subject)', () => {
  it('deduplicates one person’s memories filed under two different names', async () => {
    const older = await store.save({ category: 'fact', subject: 'OldNick', subject_user_id: '111', content: 'Likes cats and dogs very much' });
    const newer = await store.save({ category: 'fact', subject: 'Wheelie', subject_user_id: '111', content: 'Likes cats and dogs very much indeed' });
    // @ts-expect-error accessing private db for test setup
    store.db.prepare("UPDATE memories SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(older);

    const result = store.compact();

    expect(result.removed).toBe(1);
    expect(store.getAllActive().map((m) => m.id)).toEqual([newer]);
    // The FTS index stays consistent: the survivor is searchable, the duplicate is gone.
    expect((await store.search('cats dogs')).map((m) => m.id)).toEqual([newer]);
  });

  it('keeps two different people apart even when they share a display name', async () => {
    await store.save({ category: 'fact', subject: 'Alex', subject_user_id: '111', content: 'Likes cats and dogs very much' });
    await store.save({ category: 'fact', subject: 'Alex', subject_user_id: '222', content: 'Likes cats and dogs very much indeed' });

    expect(store.compact().removed).toBe(0);
    expect(store.getAllActive()).toHaveLength(2);
  });

  it('still groups name-only rows by subject', async () => {
    const a = await store.save({ category: 'fact', subject: 'server', content: 'Likes cats and dogs very much' });
    const b = await store.save({ category: 'fact', subject: 'server', content: 'Enjoys swimming every weekend morning' });
    // @ts-expect-error accessing private db for test setup
    store.db.prepare("UPDATE memories SET content = 'Likes cats and dogs very much indeed', updated_at = datetime('now', '-1 hour') WHERE id = ?").run(b);

    expect(store.compact().removed).toBe(1);
    expect(store.getAllActive().map((m) => m.id)).toEqual([a]);
  });
});
