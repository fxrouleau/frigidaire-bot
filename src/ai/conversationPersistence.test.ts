import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { ConversationPersistence } from './conversationPersistence';
import type { ConversationState } from './conversationStore';
import { CONVERSATION_STATE_SCHEMA_VERSION, type ConversationEntry } from './types';

const TIMEOUT = 15 * 60 * 1000;

let p: ConversationPersistence;

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    providerId: 'fake',
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
  it('round-trips entries (image, tool_call/tool_result, injectedMemoryIds), providerId, and timestamp', () => {
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
      providerId: 'openrouter',
      entries,
      timestamp: Date.now() - 1000,
      thoughts: { sig: 'abc' },
      injectedMemoryIds: [1, 2, 3],
    });

    p.save('chan-1', state);

    const loaded = p.loadAll(TIMEOUT);
    expect(loaded).toHaveLength(1);
    const [channelId, restored] = loaded[0];
    expect(channelId).toBe('chan-1');
    expect(restored).toEqual(state);
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
      .prepare(
        'INSERT INTO conversation_state (channel_id, schema_version, provider_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('stale-schema', CONVERSATION_STATE_SCHEMA_VERSION + 1, 'fake', JSON.stringify({ entries: [] }), Date.now());

    expect(p.loadAll(TIMEOUT)).toHaveLength(0);
    // @ts-expect-error accessing private db for verification
    const row = p.db.prepare('SELECT * FROM conversation_state WHERE channel_id = ?').get('stale-schema');
    expect(row).toBeUndefined();
  });

  it('discards and deletes a row with corrupted state_json without throwing', () => {
    // @ts-expect-error accessing private db for test setup
    p.db
      .prepare(
        'INSERT INTO conversation_state (channel_id, schema_version, provider_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('corrupt', CONVERSATION_STATE_SCHEMA_VERSION, 'fake', 'not json {{{', Date.now());

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
    const huge = 'x'.repeat(1_100_000);

    p.save('too-big', makeState({ entries: [{ kind: 'message', role: 'user', content: [{ type: 'text', text: huge }] }] }));

    expect(warn).toHaveBeenCalled();
    expect(p.loadAll(TIMEOUT)).toHaveLength(0);

    // A row that somehow lands over the cap (e.g. written by an older build) is discarded on load too.
    // @ts-expect-error accessing private db for test setup
    p.db
      .prepare(
        'INSERT INTO conversation_state (channel_id, schema_version, provider_id, state_json, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('oversized-row', CONVERSATION_STATE_SCHEMA_VERSION, 'fake', JSON.stringify({ entries: [huge] }), Date.now());

    expect(p.loadAll(TIMEOUT)).toHaveLength(0);
    // @ts-expect-error accessing private db for verification
    const row = p.db.prepare('SELECT * FROM conversation_state WHERE channel_id = ?').get('oversized-row');
    expect(row).toBeUndefined();
  });

  it('does not throw when thoughts is a circular object — the row is skipped', () => {
    const warn = vi.spyOn(logger, 'warn');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => p.save('circular', makeState({ thoughts: circular }))).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(p.loadAll(TIMEOUT)).toHaveLength(0);
  });

  it('delete removes exactly the targeted row', () => {
    p.save('keep', makeState());
    p.save('drop', makeState());

    p.delete('drop');

    const loaded = p.loadAll(TIMEOUT);
    expect(loaded.map(([id]) => id)).toEqual(['keep']);
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
});
