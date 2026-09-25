import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { ConversationPersistence, MAX_STATE_BYTES } from './conversationPersistence';
import type { ConversationState } from './conversationStore';
import { CONVERSATION_STATE_SCHEMA_VERSION, type ConversationEntry } from './types';

const TIMEOUT = 15 * 60 * 1000;

let p: ConversationPersistence;

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  p = new ConversationPersistence(':memory:');
});

afterEach(() => {
  p.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ConversationPersistence', () => {
  it('round-trips entries (image, tool_call/tool_result, injectedMemoryIds) and timestamp', () => {
    const entries: ConversationEntry[] = [
      {
        kind: 'message',
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', url: 'https://example.com/cat.png' },
        ],
      },
      { kind: 'tool_call', id: 'call-1', name: 'echo_tool', arguments: { text: 'hi' } },
      { kind: 'tool_result', id: 'call-1', name: 'echo_tool', content: 'echo result' },
      { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'a cat' }] },
    ];
    const state = makeState({
      entries,
      timestamp: Date.now() - 1000,
      injectedMemoryIds: [1, 2, 3],
    });

    p.save('chan-1', state);

    const loaded = p.loadAll(TIMEOUT);
    expect(loaded).toHaveLength(1);
    const [channelId, restored] = loaded[0];
    expect(channelId).toBe('chan-1');
    expect(restored).toEqual(state);
  });

  it('round-trips the v3 fields: message/memory ids on entries and the lastSeenMessageId watermark', () => {
    const state = makeState({
      entries: [
        { kind: 'message', role: 'developer', content: [{ type: 'text', text: 'context' }], memoryIds: [7, 9] },
        { kind: 'message', role: 'user', content: [{ type: 'text', text: 'hey' }], messageIds: ['1001'] },
        { kind: 'message', role: 'assistant', content: [{ type: 'text', text: 'yo' }], messageIds: ['1002', '1003'] },
      ],
      injectedMemoryIds: [7, 9],
      lastSeenMessageId: '1001',
    });

    p.save('chan-v3', state);

    expect(p.loadAll(TIMEOUT)).toEqual([['chan-v3', state]]);
  });

  it('upserts: saving the same channel twice keeps one row with the newest state', () => {
    p.save('chan-1', makeState({ entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] }] }));
    p.save('chan-1', makeState({ entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: 'second' }] }] }));

    const loaded = p.loadAll(TIMEOUT);
    expect(loaded).toHaveLength(1);
    const [, restored] = loaded[0];
    const firstPart = restored.entries[0];
    expect(firstPart.kind === 'message' && firstPart.content[0].type === 'text' && firstPart.content[0].text).toBe(
      'second',
    );
  });

  it('keeps a row exactly at the timeout boundary and drops+deletes one just past it (matches in-memory strict >)', () => {
    const now = 10_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // boundary: now - updated_at === TIMEOUT → strict `> TIMEOUT` is false → kept (same as the in-memory
    // store's get(): `Date.now() - timestamp > timeoutMs` is false at the boundary).
    p.save('at-boundary', makeState({ timestamp: now - TIMEOUT }));
    // just past: now - updated_at === TIMEOUT + 1 → dropped and deleted.
    p.save('just-past', makeState({ timestamp: now - TIMEOUT - 1 }));

    const loaded = p.loadAll(TIMEOUT);
    expect(loaded.map(([id]) => id)).toEqual(['at-boundary']);

    // the expired row is physically deleted, not just filtered out.
    // @ts-expect-error accessing private db for verification
    const remaining = p.db.prepare('SELECT channel_id FROM conversation_state').all() as { channel_id: string }[];
    expect(remaining.map((r) => r.channel_id)).toEqual(['at-boundary']);
  });

  it('discards and deletes a row whose schema_version does not match', () => {
    // @ts-expect-error accessing private db for test setup
    p.db
      .prepare('INSERT INTO conversation_state (channel_id, schema_version, state_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('stale-schema', CONVERSATION_STATE_SCHEMA_VERSION + 1, JSON.stringify({ entries: [] }), Date.now());

    expect(p.loadAll(TIMEOUT)).toHaveLength(0);
    // @ts-expect-error accessing private db for verification
    const row = p.db.prepare('SELECT * FROM conversation_state WHERE channel_id = ?').get('stale-schema');
    expect(row).toBeUndefined();
  });

  it('discards and deletes a row with corrupted state_json without throwing', () => {
    // @ts-expect-error accessing private db for test setup
    p.db
      .prepare('INSERT INTO conversation_state (channel_id, schema_version, state_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('corrupt', CONVERSATION_STATE_SCHEMA_VERSION, 'not json {{{', Date.now());

    let loaded: [string, ConversationState][] = [];
    expect(() => {
      loaded = p.loadAll(TIMEOUT);
    }).not.toThrow();
    expect(loaded).toHaveLength(0);
    // @ts-expect-error accessing private db for verification
    const row = p.db.prepare('SELECT * FROM conversation_state WHERE channel_id = ?').get('corrupt');
    expect(row).toBeUndefined();
  });

  it('skips an over-cap blob on save (WARN, no row) and discards an oversized row on load', () => {
    const warn = vi.spyOn(logger, 'warn');
    const huge = 'x'.repeat(MAX_STATE_BYTES + 100_000);

    p.save('too-big', makeState({ entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: huge }] }] }));

    expect(warn).toHaveBeenCalled();
    expect(p.loadAll(TIMEOUT)).toHaveLength(0);

    // A row that somehow lands over the cap (e.g. written by an older build) is discarded on load too.
    // @ts-expect-error accessing private db for test setup
    p.db
      .prepare('INSERT INTO conversation_state (channel_id, schema_version, state_json, updated_at) VALUES (?, ?, ?, ?)')
      .run('oversized-row', CONVERSATION_STATE_SCHEMA_VERSION, JSON.stringify({ entries: [huge] }), Date.now());

    expect(p.loadAll(TIMEOUT)).toHaveLength(0);
    // @ts-expect-error accessing private db for verification
    const row = p.db.prepare('SELECT * FROM conversation_state WHERE channel_id = ?').get('oversized-row');
    expect(row).toBeUndefined();
  });

  it('pruneExpired removes only rows older than the timeout', () => {
    const now = 20_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    p.save('fresh', makeState({ timestamp: now - TIMEOUT })); // boundary → kept
    p.save('stale', makeState({ timestamp: now - TIMEOUT - 1 })); // past → pruned

    p.pruneExpired(TIMEOUT);

    // @ts-expect-error accessing private db for verification
    const remaining = p.db.prepare('SELECT channel_id FROM conversation_state ORDER BY channel_id').all() as {
      channel_id: string;
    }[];
    expect(remaining.map((r) => r.channel_id)).toEqual(['fresh']);
  });

  it('drops a v1 table (multi-provider era, provider_id column) and starts fresh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-persist-'));
    const file = path.join(dir, 'conversations.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE conversation_state (
        channel_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, provider_id TEXT NOT NULL,
        state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO conversation_state VALUES ('old', 1, 'openrouter', '{"entries":[]}', ${Date.now()});
    `);
    legacy.close();

    const migrated = new ConversationPersistence(file);
    try {
      expect(migrated.loadAll(TIMEOUT)).toHaveLength(0);
      // @ts-expect-error accessing private db for verification
      const columns = migrated.db.prepare('PRAGMA table_info(conversation_state)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).not.toContain('provider_id');
      // The new-shape table is fully usable.
      migrated.save('new', makeState());
      expect(migrated.loadAll(TIMEOUT).map(([id]) => id)).toEqual(['new']);
    } finally {
      migrated.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
