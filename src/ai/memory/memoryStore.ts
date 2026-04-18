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
  subject_user_id: string | null;
};

type MemoryInput = {
  category: string;
  subject: string;
  content: string;
  source?: string;
  subject_user_id?: string;
};

export type Identity = {
  discord_user_id: string;
  display_name: string;
  canonical_name: string;
  irl_name: string | null;
  aliases: string[];
  first_seen_at: string;
  updated_at: string;
  active: number;
};

export type IdentityMetaUpdate = {
  irl_name?: string;
  aliases_add?: string[];
};

export type EmojiRow = {
  id: string;
  name: string;
  animated: number;
  caption: string | null;
  captioned_at: string | null;
  active: number;
};

type EmojiUpsertInput = {
  id: string;
  name: string;
  animated: boolean;
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

      CREATE TABLE IF NOT EXISTS identities (
        discord_user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        irl_name TEXT,
        aliases TEXT NOT NULL DEFAULT '[]',
        first_seen_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_identities_canonical_name ON identities(canonical_name);
      CREATE INDEX IF NOT EXISTS idx_identities_active ON identities(active);

      CREATE TABLE IF NOT EXISTS emojis (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        animated INTEGER NOT NULL DEFAULT 0,
        caption TEXT,
        captioned_at TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_emojis_active ON emojis(active);
    `);

    // Additive migrations for existing databases
    this.addColumnIfMissing('memories', 'subject_user_id', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject_user_id ON memories(subject_user_id);');

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
      .prepare('INSERT INTO memories (category, subject, content, source, subject_user_id) VALUES (?, ?, ?, ?, ?)')
      .run(
        memory.category,
        memory.subject,
        memory.content,
        memory.source ?? 'conversation',
        memory.subject_user_id ?? null,
      );

    const newId = Number(result.lastInsertRowid);

    // Add to FTS index
    this.db
      .prepare('INSERT INTO memories_fts(rowid, content, subject, category) VALUES(?, ?, ?, ?)')
      .run(newId, memory.content, memory.subject, memory.category);

    logger.info(`Saved new memory #${newId}: [${memory.category}] ${memory.subject} — ${memory.content}`);
    return newId;
  }

  search(query: string, limit = 20): Memory[] {
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    return this.db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts fts ON m.id = fts.rowid
         WHERE memories_fts MATCH ? AND m.active = 1
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as Memory[];
  }

  private sanitizeFtsQuery(query: string): string {
    // Strip FTS5 operator/special characters and apostrophes (token boundaries)
    const stripped = query.replace(/["',()\{\}\*:^~@!#$%&+\-]/g, ' ');
    // Split on whitespace, filter empty/single-char fragments
    const terms = stripped.split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return '';
    return terms.map((t) => `"${t}"`).join(' ');
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

  // Identity methods
  upsertIdentity(discordUserId: string, displayName: string): void {
    // Insert if new (canonical_name = displayName at time of first seen); otherwise refresh display_name.
    this.db
      .prepare(
        `INSERT INTO identities (discord_user_id, display_name, canonical_name, first_seen_at, updated_at)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(discord_user_id) DO UPDATE SET
           display_name = excluded.display_name,
           updated_at = CASE WHEN identities.display_name = excluded.display_name THEN identities.updated_at ELSE datetime('now') END`,
      )
      .run(discordUserId, displayName, displayName);
  }

  updateIdentityMeta(discordUserId: string, update: IdentityMetaUpdate): boolean {
    const existing = this.getIdentityById(discordUserId);
    if (!existing) return false;

    let nextIrl = existing.irl_name;
    let nextAliases = existing.aliases;
    let changed = false;

    if (update.irl_name !== undefined && update.irl_name.trim() !== '' && update.irl_name !== existing.irl_name) {
      nextIrl = update.irl_name.trim();
      changed = true;
    }

    if (update.aliases_add && update.aliases_add.length > 0) {
      const seen = new Set(existing.aliases);
      const additions = update.aliases_add.map((a) => a.trim()).filter((a) => a.length > 0 && !seen.has(a));
      if (additions.length > 0) {
        nextAliases = [...existing.aliases, ...additions];
        changed = true;
      }
    }

    if (!changed) return false;

    this.db
      .prepare(
        `UPDATE identities
         SET irl_name = ?, aliases = ?, updated_at = datetime('now')
         WHERE discord_user_id = ?`,
      )
      .run(nextIrl, JSON.stringify(nextAliases), discordUserId);

    return true;
  }

  getIdentityById(discordUserId: string): Identity | undefined {
    const row = this.db.prepare('SELECT * FROM identities WHERE discord_user_id = ?').get(discordUserId) as
      | (Omit<Identity, 'aliases'> & { aliases: string })
      | undefined;

    if (!row) return undefined;
    return { ...row, aliases: this.parseAliases(row.aliases) };
  }

  getAllIdentities(): Identity[] {
    const rows = this.db.prepare('SELECT * FROM identities ORDER BY canonical_name ASC').all() as (Omit<
      Identity,
      'aliases'
    > & { aliases: string })[];

    return rows.map((row) => ({ ...row, aliases: this.parseAliases(row.aliases) }));
  }

  private parseAliases(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  // Emoji methods
  upsertEmoji(emoji: EmojiUpsertInput): { inserted: boolean; nameChanged: boolean } {
    const existing = this.db.prepare('SELECT name, active FROM emojis WHERE id = ?').get(emoji.id) as
      | { name: string; active: number }
      | undefined;

    if (!existing) {
      this.db
        .prepare('INSERT INTO emojis (id, name, animated, active) VALUES (?, ?, ?, 1)')
        .run(emoji.id, emoji.name, emoji.animated ? 1 : 0);
      return { inserted: true, nameChanged: false };
    }

    const nameChanged = existing.name !== emoji.name;
    if (nameChanged || existing.active !== 1) {
      this.db
        .prepare('UPDATE emojis SET name = ?, animated = ?, active = 1 WHERE id = ?')
        .run(emoji.name, emoji.animated ? 1 : 0, emoji.id);
    }
    return { inserted: false, nameChanged };
  }

  setEmojiCaption(id: string, caption: string): void {
    this.db.prepare("UPDATE emojis SET caption = ?, captioned_at = datetime('now') WHERE id = ?").run(caption, id);
  }

  deactivateEmoji(id: string): void {
    this.db.prepare('UPDATE emojis SET active = 0 WHERE id = ?').run(id);
  }

  getEmojiById(id: string): EmojiRow | undefined {
    return this.db.prepare('SELECT * FROM emojis WHERE id = ?').get(id) as EmojiRow | undefined;
  }

  getUsableEmojis(): EmojiRow[] {
    return this.db.prepare('SELECT * FROM emojis WHERE active = 1 ORDER BY name ASC').all() as EmojiRow[];
  }

  getEmojisNeedingCaption(): EmojiRow[] {
    return this.db
      .prepare("SELECT * FROM emojis WHERE active = 1 AND (caption IS NULL OR caption = '')")
      .all() as EmojiRow[];
  }

  private addColumnIfMissing(table: string, column: string, columnDef: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef};`);
  }
}
