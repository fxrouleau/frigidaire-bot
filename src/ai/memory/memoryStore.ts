import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../../logger';
import { wordOverlap } from './wordOverlap';

export type Memory = {
  id: number;
  category: string;
  subject: string;
  content: string;
  source: string | null;
  created_at: string;
  updated_at: string;
  active: number;
};

type MemoryInput = {
  category: string;
  subject: string;
  content: string;
  source?: string;
};

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath = './data/memory.db') {
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
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        subject TEXT,
        content TEXT NOT NULL,
        source TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject);
      CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(active);

      CREATE TABLE IF NOT EXISTS learner_state (
        channel_id TEXT PRIMARY KEY,
        last_message_id TEXT NOT NULL,
        last_observed_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // FTS5 virtual table — created separately to handle already-exists gracefully
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, subject, category,
          content='memories',
          content_rowid='id'
        );
      `);
    } catch (error) {
      logger.warn('FTS5 table may already exist or is not supported:', error);
    }
  }

  save(memory: MemoryInput): number {
    // Dedup: check for existing active memories with same category + subject
    const existing = this.db
      .prepare('SELECT id, content FROM memories WHERE category = ? AND subject = ? AND active = 1')
      .all(memory.category, memory.subject) as Pick<Memory, 'id' | 'content'>[];

    for (const row of existing) {
      if (wordOverlap(row.content, memory.content) > 0.6) {
        // Update existing record instead of creating a duplicate
        this.db
          .prepare("UPDATE memories SET content = ?, updated_at = datetime('now') WHERE id = ?")
          .run(memory.content, row.id);

        // Update FTS index
        this.db
          .prepare(
            "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
          )
          .run(row.id, row.content, memory.subject, memory.category);
        this.db
          .prepare('INSERT INTO memories_fts(rowid, content, subject, category) VALUES(?, ?, ?, ?)')
          .run(row.id, memory.content, memory.subject, memory.category);

        logger.info(`Updated existing memory #${row.id} (dedup match)`);
        return row.id;
      }
    }

    const result = this.db
      .prepare('INSERT INTO memories (category, subject, content, source) VALUES (?, ?, ?, ?)')
      .run(memory.category, memory.subject, memory.content, memory.source ?? 'conversation');

    const newId = Number(result.lastInsertRowid);

    // Add to FTS index
    this.db
      .prepare('INSERT INTO memories_fts(rowid, content, subject, category) VALUES(?, ?, ?, ?)')
      .run(newId, memory.content, memory.subject, memory.category);

    logger.info(`Saved new memory #${newId}: [${memory.category}] ${memory.subject} — ${memory.content}`);
    return newId;
  }

  search(query: string, limit = 20): Memory[] {
    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.id = fts.rowid
         WHERE memories_fts MATCH ? AND m.active = 1
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as Memory[];
  }

  getBySubject(subject: string, limit = 20): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE subject = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(subject, limit) as Memory[];
  }

  getRecent(limit = 15): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE active = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as Memory[];
  }

  getByCategory(category: string, limit = 20): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories WHERE category = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?')
      .all(category, limit) as Memory[];
  }

  deactivate(id: number): void {
    const row = this.db.prepare('SELECT content, subject, category FROM memories WHERE id = ?').get(id) as
      | Pick<Memory, 'content' | 'subject' | 'category'>
      | undefined;

    this.db.prepare('UPDATE memories SET active = 0 WHERE id = ?').run(id);

    if (row) {
      this.db
        .prepare(
          "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
        )
        .run(id, row.content, row.subject, row.category);
    }
  }

  remove(id: number): void {
    const row = this.db.prepare('SELECT content, subject, category FROM memories WHERE id = ?').get(id) as
      | Pick<Memory, 'content' | 'subject' | 'category'>
      | undefined;

    if (row) {
      this.db
        .prepare(
          "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
        )
        .run(id, row.content, row.subject, row.category);
    }

    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  getAllActive(): Memory[] {
    return this.db.prepare('SELECT * FROM memories WHERE active = 1 ORDER BY updated_at DESC').all() as Memory[];
  }

  compact(): { merged: number; removed: number } {
    const allActive = this.getAllActive();
    let removed = 0;

    // Group by subject + category
    const groups = new Map<string, Memory[]>();
    for (const mem of allActive) {
      const key = `${mem.subject}::${mem.category}`;
      const group = groups.get(key);
      if (group) {
        group.push(mem);
      } else {
        groups.set(key, [mem]);
      }
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      // Sort by updated_at descending (newest first)
      group.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (wordOverlap(group[i].content, group[j].content) > 0.6) {
            // Keep newer (i), deactivate older (j)
            this.deactivate(group[j].id);
            removed++;
            logger.info(`Compacted: deactivated memory #${group[j].id} (overlap with #${group[i].id})`);
          }
        }
      }
    }

    return { merged: 0, removed };
  }

  // Learner state methods
  getLastObserved(channelId: string): string | null {
    const row = this.db.prepare('SELECT last_message_id FROM learner_state WHERE channel_id = ?').get(channelId) as
      | { last_message_id: string }
      | undefined;
    return row?.last_message_id ?? null;
  }

  setLastObserved(channelId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT INTO learner_state (channel_id, last_message_id, last_observed_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(channel_id) DO UPDATE SET last_message_id = ?, last_observed_at = datetime('now')`,
      )
      .run(channelId, messageId, messageId);
  }
}
