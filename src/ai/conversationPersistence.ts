import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../logger';
import type { ConversationState } from './conversationStore';
import { CONVERSATION_STATE_SCHEMA_VERSION } from './types';

// The mutable, JSON-serializable slice of a ConversationState: providerId and timestamp live in their
// own columns, the rest goes through JSON.stringify. thoughts is `unknown` on the type, so a
// serialization failure (circular ref, BigInt, …) is possible — save() degrades to skipping the row.
type SerializedState = {
  entries: ConversationState['entries'];
  thoughts?: unknown;
  injectedMemoryIds?: number[];
};

// Hard cap on a serialized state blob. A runaway conversation should degrade to "not persisted"
// rather than bloat the cache DB; matches the in-memory store's source-of-truth role.
const MAX_STATE_BYTES = 1_000_000;

type StateRow = {
  channel_id: string;
  schema_version: number;
  provider_id: string;
  state_json: string;
  updated_at: number;
};

/**
 * SQLite-backed cache of per-channel conversation state, so active conversations survive a bot
 * restart (the bot redeploys on every master merge) within the in-memory store's timeout window.
 *
 * Deliberately a SEPARATE DB file from memory.db: opposite lifecycle (a disposable session cache vs
 * durable long-term memory) and memory.db's WAL pragmas are tuned for 16KB embedding blobs. Mirrors
 * MemoryStore's conventions: WAL, lazy prepared-statement cache, runInTransaction, ':memory:' for
 * tests. The in-memory Map in ConversationStore stays the source of truth — every method here is
 * best-effort, never throwing into the conversation path.
 */
export class ConversationPersistence {
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(dbPath = './data/conversations.db') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_state (
        channel_id     TEXT    PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        provider_id    TEXT    NOT NULL,
        state_json     TEXT    NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_state_updated_at ON conversation_state(updated_at);
    `);
  }

  /**
   * Upserts a channel's state. Best-effort: a serialization failure, or a blob over MAX_STATE_BYTES,
   * logs a WARN and skips the write (the in-memory store keeps the live copy) — it never throws.
   */
  save(channelId: string, state: ConversationState): void {
    const serializable: SerializedState = {
      entries: state.entries,
      thoughts: state.thoughts,
      injectedMemoryIds: state.injectedMemoryIds,
    };

    let stateJson: string;
    try {
      stateJson = JSON.stringify(serializable);
    } catch (error) {
      logger.warn(`Skipping conversation persistence for #${channelId}: state is not serializable.`, error);
      return;
    }

    if (Buffer.byteLength(stateJson, 'utf8') > MAX_STATE_BYTES) {
      logger.warn(`Skipping conversation persistence for #${channelId}: serialized state exceeds the size cap.`);
      return;
    }

    this.stmt(
      `INSERT INTO conversation_state (channel_id, schema_version, provider_id, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         provider_id = excluded.provider_id,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run(channelId, CONVERSATION_STATE_SCHEMA_VERSION, state.providerId, stateJson, state.timestamp);
  }

  /**
   * Returns every persisted state that is still usable, as [channelId, ConversationState] pairs for
   * seeding the in-memory Map. A row is usable only if it passes ALL guards: within the timeout window
   * (same strict boundary as the in-memory store's `Date.now() - timestamp > timeoutMs` expiry),
   * current schema_version, blob within the size cap, and parseable JSON. Any row failing a guard is
   * DELETE-d in the same pass — load doubles as a self-cleaning prune of stale/corrupt rows.
   */
  loadAll(timeoutMs: number): [string, ConversationState][] {
    const rows = this.stmt('SELECT * FROM conversation_state').all() as StateRow[];
    const now = Date.now();
    const result: [string, ConversationState][] = [];

    return this.runInTransaction(() => {
      for (const row of rows) {
        const state = this.rowToState(row, now, timeoutMs);
        if (state) {
          result.push([row.channel_id, state]);
        } else {
          this.stmt('DELETE FROM conversation_state WHERE channel_id = ?').run(row.channel_id);
        }
      }
      return result;
    });
  }

  /** Validates one row against every guard, returning the reconstructed state or null (caller deletes). */
  private rowToState(row: StateRow, now: number, timeoutMs: number): ConversationState | null {
    if (now - row.updated_at > timeoutMs) return null;
    if (row.schema_version !== CONVERSATION_STATE_SCHEMA_VERSION) return null;
    if (Buffer.byteLength(row.state_json, 'utf8') > MAX_STATE_BYTES) return null;

    let parsed: SerializedState;
    try {
      parsed = JSON.parse(row.state_json) as SerializedState;
    } catch {
      return null;
    }

    return {
      providerId: row.provider_id,
      entries: parsed.entries ?? [],
      timestamp: row.updated_at,
      thoughts: parsed.thoughts,
      injectedMemoryIds: parsed.injectedMemoryIds,
    };
  }

  delete(channelId: string): void {
    this.stmt('DELETE FROM conversation_state WHERE channel_id = ?').run(channelId);
  }

  /** Deletes every row older than the timeout (same strict boundary as the in-memory store's expiry). */
  pruneExpired(timeoutMs: number): void {
    const cutoff = Date.now() - timeoutMs;
    this.stmt('DELETE FROM conversation_state WHERE updated_at < ?').run(cutoff);
  }

  close(): void {
    this.db.close();
  }

  /** Returns the cached prepared statement for this SQL, compiling it on first use. */
  private stmt(sql: string): Database.Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  private runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

let conversationPersistence: ConversationPersistence | undefined;

export function getConversationPersistence(): ConversationPersistence {
  if (!conversationPersistence) {
    // Test hermeticity: inside Vitest an un-injected instance must never touch the on-disk cache DB.
    conversationPersistence = process.env.VITEST
      ? new ConversationPersistence(':memory:')
      : new ConversationPersistence();
  }
  return conversationPersistence;
}

/** Test-only: points the shared persistence at an isolated instance (e.g. ':memory:'). */
export function setConversationPersistenceForTesting(p: ConversationPersistence | undefined): void {
  conversationPersistence = p;
}
