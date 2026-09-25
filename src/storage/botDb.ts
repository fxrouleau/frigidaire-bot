// Shared SQLite handle for the small feature tables that are not part of the memory model: relayed
// messages, reminders, birthdays, voice transcripts, the usage/cost ledger, and so on. One file
// (./data/bot.db) instead of one database per feature; each feature owns its tables and creates them
// lazily with ensureSchema(). memory.db stays the long-term memory store, and the message archive gets
// its own file because of its size.
//
// Under Vitest the default instance is ':memory:' (structural test hermeticity, like memory.db and
// conversations.db); tests that need isolation per case inject a fresh one with setBotDbForTesting().
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';

export class BotDb {
  readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly schemas = new Set<string>();

  constructor(dbPath = './data/bot.db') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Runs `ddl` the first time `key` is seen by this instance. The DDL must be idempotent
   * (CREATE TABLE/INDEX IF NOT EXISTS) because every process start runs it again.
   */
  ensureSchema(key: string, ddl: string): void {
    if (this.schemas.has(key)) return;
    this.db.exec(ddl);
    this.schemas.add(key);
  }

  /** Returns the cached prepared statement for this SQL, compiling it on first use. */
  stmt(sql: string): Database.Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  /** Runs fn inside a transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

let botDb: BotDb | undefined;

export function getBotDb(): BotDb {
  if (!botDb) {
    botDb = config.isTest ? new BotDb(':memory:') : new BotDb();
  }
  return botDb;
}

/** Test-only: points the shared handle at an isolated instance (e.g. `new BotDb(':memory:')`). */
export function setBotDbForTesting(db: BotDb | undefined): void {
  botDb = db;
}
