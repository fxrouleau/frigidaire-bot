import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../../logger';
import type { EmbeddingProvider } from './embeddingProvider';
import { blobToVector, dot, vectorToBlob } from './vectorMath';
import { wordOverlap } from './wordOverlap';

export type Memory = {
  id: number;
  category: string;
  // The DDL allows NULL for legacy reasons (the prod table cannot gain NOT NULL without a rebuild),
  // but every write path requires a string and the real prod data has zero NULL subjects (verified
  // against 1,937 rows) — so the TS type stays the honest `string`.
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
  use_count: number;
  last_used_at: string | null;
};

type EmojiUpsertInput = {
  id: string;
  name: string;
  animated: boolean;
};

export type MemoryStoreOptions = {
  /** When present, save() embeds memories and runs semantic dedup; absent ⇒ FTS5-only (legacy) behavior. */
  embeddings?: EmbeddingProvider;
  /** Cosine similarity at/above which two memories are duplicates. Default: MEMORY_DEDUP_THRESHOLD env or 0.9. */
  dedupThreshold?: number;
  /** Minimum cosine similarity for a memory to be returned by search(). Default: MEMORY_RELEVANCE_THRESHOLD env or 0.5. */
  relevanceThreshold?: number;
  /**
   * Per-category TTLs in HOURS for "ephemeral" memories: sweepExpiredMemories() deactivates memories in
   * these categories once their updated_at is older than the TTL. Categories not listed (or with a TTL
   * of 0 or less) never expire. When omitted, defaults come from the environment:
   * image = MEMORY_TTL_IMAGE_HOURS (24), event = MEMORY_TTL_EVENT_DAYS (14) × 24.
   */
  ttls?: Record<string, number>;
};

/** Result of the synchronous phase of save(): the durable row id, and whether it merged into an existing row. */
type LexicalSaveResult = {
  id: number;
  merged: boolean;
};

/** An entry in the in-memory vector cache. category/subject are immutable per memory id, so they can't go stale. */
type CachedVector = {
  vec: Float32Array;
  category: string;
  subject: string;
};

const DEFAULT_DEDUP_THRESHOLD = 0.9;
const DEFAULT_RELEVANCE_THRESHOLD = 0.5;

// Reciprocal-rank-fusion parameters for hybrid search: vector leg dominates, FTS is a booster.
const RRF_K = 60;
const RRF_VECTOR_WEIGHT = 1.0;
const RRF_KEYWORD_WEIGHT = 0.5;

// The semantic gate only engages when at least this fraction of searchable active memories have
// current-model vectors. Below it (fresh DB, mid-backfill, model switch, prolonged API outage),
// gated search would silently hide the un-embedded majority — ungated FTS is more useful and honest.
const SEMANTIC_COVERAGE_THRESHOLD = 0.8;

/**
 * Categories that describe the bot itself (capability gaps, errors, improvement signals) rather than
 * the server and its members. search() excludes them by default — injecting "bot can't read links"
 * into a food conversation is pure pollution. query_self_diagnosis / getByCategory() remain their
 * access path. Exported as the single source of truth (tools.ts imports it).
 */
export const SELF_DIAGNOSIS_CATEGORIES = [
  'capability_gap',
  'pain_point',
  'feature_request',
  'improvement_idea',
  'parse_failure',
  'tool_error',
  'missing_context',
  'unrecognized_content',
] as const;

const SELF_DIAGNOSIS_SET: ReadonlySet<string> = new Set(SELF_DIAGNOSIS_CATEGORIES);

// Inline literal list for SQL. Safe: values are compile-time constants (no injection surface), and
// EXPLAIN QUERY PLAN on the prod DB confirms literal vs bound params produce identical plans
// (the exclusion is a post-join filter on PK-fetched rows; no index is involved either way).
const SELF_DIAGNOSIS_NOT_IN = SELF_DIAGNOSIS_CATEGORIES.map((c) => `'${c}'`).join(', ');

/**
 * The exact text sent to the embeddings API for a memory. Stored verbatim in
 * memory_embeddings.input_text as an audit trail of what each vector represents; re-embedding
 * (backfill, model switches) always rebuilds this from the memory's CURRENT content.
 */
export function buildEmbeddingInput(memory: Pick<MemoryInput, 'subject' | 'content'>): string {
  return memory.subject ? `${memory.subject}: ${memory.content}` : memory.content;
}

/**
 * Default per-category ephemeral-memory TTLs (in hours), env-overridable. Ephemeral observations
 * ("Jason shared a photo of a hotdog", "movie night happened on Saturday") should be retrievable
 * while fresh and then expire — they're moments, not durable facts. A TTL of 0 disables expiry
 * for that category.
 */
function defaultTtls(): Record<string, number> {
  const ttls: Record<string, number> = {};
  const imageHours = envNumber('MEMORY_TTL_IMAGE_HOURS', 24);
  if (imageHours > 0) ttls.image = imageHours;
  const eventDays = envNumber('MEMORY_TTL_EVENT_DAYS', 14);
  if (eventDays > 0) ttls.event = eventDays * 24;
  return ttls;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class MemoryStore {
  private readonly db: Database.Database;
  private readonly embeddings?: EmbeddingProvider;
  private readonly dedupThreshold: number;
  private readonly relevanceThreshold: number;
  // Per-category ephemeral TTLs in hours (see MemoryStoreOptions.ttls / sweepExpiredMemories()).
  private readonly ttls: Record<string, number>;
  // Prepared-statement cache keyed by SQL text: each statement is compiled once and reused
  // (previously every call re-prepared its statements). Lazy so optional features (FTS5) keep
  // failing exactly where they failed before if the SQLite build lacks them.
  private readonly statements = new Map<string, Database.Statement>();
  // In-memory cache of all ACTIVE memories' CURRENT-MODEL vectors (~16KB/memory at 4096 dims;
  // ~30MB at real prod scale). Avoids re-reading + converting every BLOB on every search
  // (measured: 41.6ms + ~48MB transient allocations per search without it, 16ms with it).
  // Kept consistent write-through by upsertVector()/deleteVectors(); null ⇒ lazily reloaded on next use.
  private vectorCache: Map<number, CachedVector> | null = null;
  private vectorCacheModel: string | null = null;
  // True while a backfillEmbeddings() run is awaiting the API — prevents overlapping runs.
  private backfillInFlight = false;

  constructor(dbPath = './data/memory.db', opts: MemoryStoreOptions = {}) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // Embedding BLOBs (16KB each at 4096 dims) grow the WAL far faster than the old all-text rows;
    // checkpoint at 256 pages (~1MB) instead of the 1000-page default to keep the WAL file bounded.
    this.db.pragma('wal_autocheckpoint = 256');

    this.embeddings = opts.embeddings;
    this.dedupThreshold = opts.dedupThreshold ?? envNumber('MEMORY_DEDUP_THRESHOLD', DEFAULT_DEDUP_THRESHOLD);
    this.relevanceThreshold =
      opts.relevanceThreshold ?? envNumber('MEMORY_RELEVANCE_THRESHOLD', DEFAULT_RELEVANCE_THRESHOLD);
    this.ttls = opts.ttls ?? defaultTtls();

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

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        active INTEGER DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_emojis_active ON emojis(active);
    `);

    // Additive migrations for existing databases
    this.addColumnIfMissing('memories', 'subject_user_id', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_subject_user_id ON memories(subject_user_id);');
    this.addColumnIfMissing('emojis', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('emojis', 'last_used_at', 'TEXT');

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

    // Embedding vectors: one row per (memory, embedding model) — 1:N during a model transition,
    // 1:1 steady-state. UNIQUE(memory_id, model) is both the upsert target and the point-lookup index.
    // The FK is enforced (better-sqlite3 turns PRAGMA foreign_keys ON by default): inserting a vector
    // for a nonexistent memory fails loudly, and hard-deleting a memory cascades to its vectors.
    // deactivate() is an UPDATE (no cascade), so explicit vector deletes + compact()'s orphan sweep stay.
    // Plain rowid table on purpose: 16KB blobs belong in the rowid b-tree, not a WITHOUT ROWID tree.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        model       TEXT    NOT NULL,
        dims        INTEGER NOT NULL CHECK (dims > 0),
        input_text  TEXT    NOT NULL,
        vector      BLOB    NOT NULL CHECK (length(vector) = dims * 4),
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        UNIQUE (memory_id, model)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);
    `);
  }

  /**
   * Saves a memory.
   *
   * PHASE 1 — synchronous, before any await: lexical (word-overlap) dedup + INSERT/UPDATE + FTS sync,
   * all in one transaction. The row is durable when this phase returns, so fire-and-forget callers and
   * tests that read back immediately after `save()` resolves (or even before) stay correct.
   *
   * PHASE 2 — async, best-effort, only when an embedding provider is configured: embed the memory,
   * run semantic (cosine) dedup against same-(category, subject) vectors, and store the vector.
   * Phase-2 failures never lose the phase-1 row; backfillEmbeddings() heals missing vectors later.
   */
  async save(memory: MemoryInput): Promise<number> {
    const phase1 = this.lexicalSave(memory);

    if (!this.embeddings) return phase1.id;

    try {
      const inputText = buildEmbeddingInput(memory);
      const [vector] = await this.embeddings.embed([inputText], 'document');
      return this.finishSemanticSave(phase1, memory, inputText, vector);
    } catch (error) {
      logger.warn(`Embedding for memory #${phase1.id} failed (backfill will heal it):`, error);
      return phase1.id;
    }
  }

  /** Phase 1 of save(): today's lexical dedup + write + FTS sync, wrapped in a transaction. */
  private lexicalSave(memory: MemoryInput): LexicalSaveResult {
    return this.runInTransaction(() => {
      const existing = this.stmt(
        'SELECT id, content FROM memories WHERE category = ? AND subject = ? AND active = 1',
      ).all(memory.category, memory.subject) as Pick<Memory, 'id' | 'content'>[];

      for (const row of existing) {
        if (wordOverlap(row.content, memory.content) > 0.6) {
          // Update existing record instead of creating a duplicate
          this.updateMemoryContent(row.id, row.content, memory);
          logger.info(`Updated existing memory #${row.id} (dedup match)`);
          return { id: row.id, merged: true };
        }
      }

      const result = this.stmt(
        'INSERT INTO memories (category, subject, content, source, subject_user_id) VALUES (?, ?, ?, ?, ?)',
      ).run(
        memory.category,
        memory.subject,
        memory.content,
        memory.source ?? 'conversation',
        memory.subject_user_id ?? null,
      );

      const newId = Number(result.lastInsertRowid);

      // Add to FTS index
      this.stmt('INSERT INTO memories_fts(rowid, content, subject, category) VALUES(?, ?, ?, ?)').run(
        newId,
        memory.content,
        memory.subject,
        memory.category,
      );

      logger.info(`Saved new memory #${newId}: [${memory.category}] ${memory.subject} — ${memory.content}`);
      return { id: newId, merged: false };
    });
  }

  /**
   * Phase 2 of save(): store the vector, after checking for a semantic duplicate among memories with
   * the same (category, subject). On a duplicate, the EXISTING id survives with the new content
   * (ids are user-visible via recall_memories/forget_memory) and the phase-1 row is deleted.
   * Runs as a single transaction.
   */
  private finishSemanticSave(
    phase1: LexicalSaveResult,
    memory: MemoryInput,
    inputText: string,
    vector: Float32Array,
  ): number {
    const embeddings = this.embeddings;
    if (!embeddings) return phase1.id;

    const meta = { category: memory.category, subject: memory.subject };

    return this.runInTransaction(() => {
      // The phase-1 row may have changed while we awaited the embeddings API: forget_memory could
      // have deactivated/removed it, or another save() could have merged newer content into it
      // (that save's own phase 2 embeds the newer text). Mirror backfill's staleness check — never
      // write a vector for an inactive row or from stale text; the backfill heals any gap later.
      const current = this.stmt('SELECT content, active FROM memories WHERE id = ?').get(phase1.id) as
        | Pick<Memory, 'content' | 'active'>
        | undefined;
      if (
        !current ||
        current.active !== 1 ||
        buildEmbeddingInput({ ...memory, content: current.content }) !== inputText
      ) {
        return phase1.id;
      }

      // If phase 1 merged into a pre-existing row, that row IS the established memory — never delete
      // it in favor of another; just store/refresh its vector.
      if (phase1.merged) {
        this.upsertVector(phase1.id, embeddings.model, inputText, vector, meta);
        return phase1.id;
      }

      // Semantic dedup against the same (category, subject) group, via the vector cache.
      // Vectors are L2-normalized, so dot product == cosine similarity.
      const cache = this.getVectorCache(embeddings.model);
      let bestId: number | undefined;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const [id, entry] of cache) {
        if (id === phase1.id) continue;
        if (entry.category !== memory.category || entry.subject !== memory.subject) continue;
        // Dimension mismatch (e.g. a model changed its output size under the same id) — skip, don't blow up.
        if (entry.vec.length !== vector.length) continue;
        const score = dot(vector, entry.vec);
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
        }
      }

      if (bestId !== undefined && bestScore >= this.dedupThreshold) {
        const existing = this.stmt('SELECT content FROM memories WHERE id = ?').get(bestId) as Pick<Memory, 'content'>;
        this.updateMemoryContent(bestId, existing.content, memory);
        this.removeInCurrentTransaction(phase1.id);
        this.upsertVector(bestId, embeddings.model, inputText, vector, meta);
        logger.info(`Memory #${phase1.id} merged into #${bestId} (semantic dedup, cosine ${bestScore.toFixed(3)})`);
        return bestId;
      }

      this.upsertVector(phase1.id, embeddings.model, inputText, vector, meta);
      return phase1.id;
    });
  }

  /** Updates a memory's content + updated_at and keeps the FTS index in sync. Caller provides the OLD content. */
  private updateMemoryContent(id: number, oldContent: string, memory: MemoryInput): void {
    this.stmt("UPDATE memories SET content = ?, updated_at = datetime('now') WHERE id = ?").run(memory.content, id);

    // External-content FTS5: the 'delete' command must be given the OLD column values.
    this.stmt(
      "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
    ).run(id, oldContent, memory.subject, memory.category);
    this.stmt('INSERT INTO memories_fts(rowid, content, subject, category) VALUES(?, ?, ?, ?)').run(
      id,
      memory.content,
      memory.subject,
      memory.category,
    );
  }

  /**
   * Hybrid semantic + keyword search over conversational memories.
   *
   * Vector-primary with FTS5 as a keyword booster: legs are RRF-fused, but every returned memory must
   * pass the semantic gate (cosine ≥ relevance threshold). FTS can boost the rank of semantically
   * relevant memories or surface ones the vector leg ranked low — it can never introduce a memory the
   * query isn't semantically related to.
   *
   * Ungated FTS fallback (legacy behavior, logged at WARN) when: no embedder is configured, the query
   * embed fails, or current-model vector coverage is below SEMANTIC_COVERAGE_THRESHOLD (fresh DB,
   * mid-backfill, model switch, prolonged API outage).
   *
   * Self-diagnosis categories are always excluded from both legs — see SELF_DIAGNOSIS_CATEGORIES.
   */
  async search(query: string, limit = 20): Promise<Memory[]> {
    // Degenerate queries (empty, whitespace, punctuation-only, single-char terms) have always
    // returned [] (the legacy FTS path had no terms to match). Keep that contract: never spend a
    // paid embed call on them, and never embed a near-empty string — the qwen3 instruct prefix
    // would dominate its vector and score arbitrary memories above the relevance gate.
    if (!this.sanitizeFtsQuery(query)) return [];

    const ftsRows = this.searchFts(query, Math.max(limit, 50));

    if (!this.embeddings) return ftsRows.slice(0, limit);

    let queryVec: Float32Array;
    try {
      [queryVec] = await this.embeddings.embed([query], 'query');
    } catch (error) {
      logger.warn('Memory search: ungated FTS fallback (query embed failed):', error);
      return ftsRows.slice(0, limit);
    }

    const cache = this.getVectorCache(this.embeddings.model);

    // Coverage gate (also covers the zero-vectors case).
    const searchableTotal = (
      this.stmt(
        `SELECT COUNT(*) AS n FROM memories WHERE active = 1 AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN})`,
      ).get() as { n: number }
    ).n;
    let searchableCovered = 0;
    for (const entry of cache.values()) {
      if (!SELF_DIAGNOSIS_SET.has(entry.category)) searchableCovered++;
    }
    if (searchableTotal === 0 || searchableCovered / searchableTotal < SEMANTIC_COVERAGE_THRESHOLD) {
      if (searchableTotal > 0) {
        logger.warn(
          `Memory search: ungated FTS fallback (vector coverage ${searchableCovered}/${searchableTotal} below ${SEMANTIC_COVERAGE_THRESHOLD * 100}%)`,
        );
      }
      return ftsRows.slice(0, limit);
    }

    // Vector leg: cosine over cached vectors (normalized ⇒ dot product), self-diagnosis excluded.
    const vectorScored: { id: number; cosine: number }[] = [];
    for (const [id, entry] of cache) {
      if (SELF_DIAGNOSIS_SET.has(entry.category)) continue;
      if (entry.vec.length !== queryVec.length) continue; // dims mismatch safety
      vectorScored.push({ id, cosine: dot(queryVec, entry.vec) });
    }
    vectorScored.sort((a, b) => b.cosine - a.cosine);

    // RRF fusion. A leg a memory is missing from contributes 0.
    const cosineById = new Map<number, number>();
    const fusedById = new Map<number, number>();
    vectorScored.forEach((v, rank) => {
      cosineById.set(v.id, v.cosine);
      fusedById.set(v.id, (fusedById.get(v.id) ?? 0) + RRF_VECTOR_WEIGHT / (RRF_K + rank + 1));
    });
    ftsRows.forEach((m, rank) => {
      fusedById.set(m.id, (fusedById.get(m.id) ?? 0) + RRF_KEYWORD_WEIGHT / (RRF_K + rank + 1));
    });

    // SEMANTIC GATE: candidates without a computable cosine (keyword-only hits on un-embedded
    // memories) or below the relevance threshold are dropped.
    const gatedIds = [...fusedById.keys()].filter((id) => {
      const cosine = cosineById.get(id);
      return cosine !== undefined && cosine >= this.relevanceThreshold;
    });
    gatedIds.sort((a, b) => (fusedById.get(b) ?? 0) - (fusedById.get(a) ?? 0));

    // Calibration data (LOG_DEBUG=1): the top of the cosine distribution vs the gate.
    const topCosines = vectorScored
      .slice(0, 5)
      .map((v) => `#${v.id}:${v.cosine.toFixed(3)}`)
      .join(', ');
    logger.debug(
      `Memory search: top cosines [${topCosines}], gate=${this.relevanceThreshold}, passed=${gatedIds.length}, fts=${ftsRows.length}`,
    );

    return this.fetchMemoriesByIds(gatedIds.slice(0, limit));
  }

  /** The FTS5 keyword leg (and the ungated fallback): BM25-ranked, active-only, self-diagnosis excluded. */
  private searchFts(query: string, limit: number): Memory[] {
    const sanitized = this.sanitizeFtsQuery(query);
    if (!sanitized) return [];

    return this.stmt(
      `SELECT m.* FROM memories m
       JOIN memories_fts fts ON m.id = fts.rowid
       WHERE memories_fts MATCH ? AND m.active = 1
         AND m.category NOT IN (${SELF_DIAGNOSIS_NOT_IN})
       ORDER BY rank
       LIMIT ?`,
    ).all(sanitized, limit) as Memory[];
  }

  /** Fetches active memory rows by id, preserving the order of the input ids. Never returns vector blobs. */
  private fetchMemoriesByIds(ids: number[]): Memory[] {
    if (ids.length === 0) return [];

    const rows = this.stmt('SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND active = 1').all(
      JSON.stringify(ids),
    ) as Memory[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((m): m is Memory => m !== undefined);
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
    return this.stmt('SELECT * FROM memories WHERE subject = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?').all(
      subject,
      limit,
    ) as Memory[];
  }

  getRecent(limit = 15): Memory[] {
    return this.stmt('SELECT * FROM memories WHERE active = 1 ORDER BY updated_at DESC LIMIT ?').all(limit) as Memory[];
  }

  getByCategory(category: string, limit = 20): Memory[] {
    return this.stmt('SELECT * FROM memories WHERE category = ? AND active = 1 ORDER BY updated_at DESC LIMIT ?').all(
      category,
      limit,
    ) as Memory[];
  }

  deactivate(id: number): void {
    this.runInTransaction(() => {
      const row = this.stmt('SELECT content, subject, category FROM memories WHERE id = ?').get(id) as
        | Pick<Memory, 'content' | 'subject' | 'category'>
        | undefined;

      this.stmt('UPDATE memories SET active = 0 WHERE id = ?').run(id);

      if (row) {
        this.stmt(
          "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
        ).run(id, row.content, row.subject, row.category);
      }

      // Deactivated memories are never searched or reactivated — their vectors go too.
      this.deleteVectors(id);
    });
  }

  remove(id: number): void {
    this.runInTransaction(() => {
      this.removeInCurrentTransaction(id);
    });
  }

  /** The body of remove(), for use inside an already-open transaction. */
  private removeInCurrentTransaction(id: number): void {
    const row = this.stmt('SELECT content, subject, category FROM memories WHERE id = ?').get(id) as
      | Pick<Memory, 'content' | 'subject' | 'category'>
      | undefined;

    if (row) {
      this.stmt(
        "INSERT INTO memories_fts(memories_fts, rowid, content, subject, category) VALUES('delete', ?, ?, ?, ?)",
      ).run(id, row.content, row.subject, row.category);
    }

    this.deleteVectors(id);
    this.stmt('DELETE FROM memories WHERE id = ?').run(id);
  }

  getAllActive(): Memory[] {
    return this.stmt('SELECT * FROM memories WHERE active = 1 ORDER BY updated_at DESC').all() as Memory[];
  }

  /**
   * Deactivates "ephemeral" memories whose per-category TTL has passed (see MemoryStoreOptions.ttls;
   * defaults: image after 24 hours, event after 14 days).
   *
   * Contract:
   * - The clock is `updated_at`, not `created_at`: a dedup-merge re-observation refreshes a memory's
   *   freshness (a re-shared image starts a new TTL window) — expiring on created_at would deactivate
   *   memories the learner just re-confirmed.
   * - The boundary is strict `<`: a memory aged exactly TTL is NOT yet expired.
   * - The comparison happens in SQLite time (datetime('now')), so tests that age rows via SQL
   *   timestamps are deterministic.
   * - Expiry is the existing soft-delete: deactivate() per row, which also cleans the FTS index,
   *   deletes vectors, and updates the in-memory cache. Never a bulk UPDATE that would bypass those.
   * - Idempotent and cheap (indexed SELECT per TTL'd category); safe to run at startup (via compact())
   *   and on every maintenance interval.
   */
  sweepExpiredMemories(): { expired: number } {
    let expired = 0;
    const breakdown: string[] = [];

    for (const [category, ttlHours] of Object.entries(this.ttls)) {
      // TTL of 0 (or anything non-positive/invalid) = expiry disabled for this category.
      if (!Number.isFinite(ttlHours) || ttlHours <= 0) continue;

      const rows = this.stmt(
        "SELECT id FROM memories WHERE active = 1 AND category = ? AND updated_at < datetime('now', ?)",
      ).all(category, `-${ttlHours} hours`) as { id: number }[];

      for (const row of rows) {
        this.deactivate(row.id);
      }
      if (rows.length > 0) {
        expired += rows.length;
        breakdown.push(`${category}: ${rows.length}`);
      }
    }

    if (expired > 0) {
      logger.info(`Expired ${expired} ephemeral memories past their TTL (${breakdown.join(', ')})`);
    }
    return { expired };
  }

  /**
   * Startup maintenance: expires ephemeral memories, sweeps orphaned vectors, deduplicates active
   * memories within each (subject, category) group — semantically (cosine) when both sides have
   * current-model vectors, lexically (word overlap) otherwise — and refreshes the query planner's
   * statistics. Stays synchronous: it only ever uses vectors that are already stored, never the
   * embeddings API.
   */
  compact(): { removed: number; expired: number } {
    // 0. Ephemeral TTL sweep first: expired memories shouldn't waste dedup cycles below, and their
    //    vector/FTS cleanup happens inside deactivate().
    const { expired } = this.sweepExpiredMemories();

    // 1. Orphan-vector sweep. The FK's ON DELETE CASCADE makes hard-delete orphans impossible;
    //    this is the backstop for deactivations and anything historical.
    const swept = this.stmt(
      'DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories WHERE active = 1)',
    ).run();
    if (swept.changes > 0) {
      logger.info(`Compact: swept ${swept.changes} orphaned vector row(s)`);
      this.invalidateVectorCache();
    }

    const allActive = this.getAllActive();
    let removed = 0;

    // Cosine dedup reads stored vectors via the cache (loads it once; no API calls).
    const cache = this.embeddings ? this.getVectorCache(this.embeddings.model) : null;

    // 2. Group by subject + category
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
          // Semantic comparison when both sides have current-model vectors; lexical fallback otherwise.
          const vecI = cache?.get(group[i].id)?.vec;
          const vecJ = cache?.get(group[j].id)?.vec;
          const isDuplicate =
            vecI && vecJ && vecI.length === vecJ.length
              ? dot(vecI, vecJ) >= this.dedupThreshold
              : wordOverlap(group[i].content, group[j].content) > 0.6;

          if (isDuplicate) {
            // Keep newer (i), deactivate older (j)
            this.deactivate(group[j].id);
            removed++;
            logger.info(`Compacted: deactivated memory #${group[j].id} (duplicate of #${group[i].id})`);
          }
        }
      }
    }

    // 3. Refresh query-planner statistics (SQLite's recommended hygiene for long-lived connections;
    //    the prod DB has never had ANALYZE run).
    this.db.pragma('optimize');

    return { removed, expired };
  }

  /**
   * Embeds every active memory that lacks a current-model vector (new memories saved during API
   * outages, and every memory after an EMBEDDING_MODEL switch). Idempotent; safe to run at startup
   * and on an interval. Never throws — failures are counted and retried on the next run.
   *
   * Expand-contract on model switches: new-model vectors are written alongside old-model ones, and
   * old-model vectors are pruned only for memories that have a current-model vector (so rolling back
   * EMBEDDING_MODEL is instant for anything not yet re-embedded).
   */
  async backfillEmbeddings(batchSize = 32): Promise<{ embedded: number; reembedded: number; failed: number }> {
    const counts = { embedded: 0, reembedded: 0, failed: 0 };
    const embeddings = this.embeddings;
    if (!embeddings) return counts;

    // In-flight guard: a slow API can make the startup run overlap the periodic run. Upserts are
    // idempotent so overlap can't corrupt anything — it would only duplicate paid API calls.
    if (this.backfillInFlight) {
      logger.info('Embedding backfill: a run is already in progress, skipping');
      return counts;
    }
    this.backfillInFlight = true;

    try {
      // Active memories lacking a current-model vector. Searchable categories first (they serve
      // retrieval immediately); self-diagnosis last (their vectors only serve save-time dedup).
      const rows = this.stmt(
        `SELECT m.id, m.category, m.subject, m.content,
                EXISTS (SELECT 1 FROM memory_embeddings e2 WHERE e2.memory_id = m.id) AS had_vector
         FROM memories m
         WHERE m.active = 1
           AND NOT EXISTS (SELECT 1 FROM memory_embeddings e WHERE e.memory_id = m.id AND e.model = ?)
         ORDER BY (CASE WHEN m.category IN (${SELF_DIAGNOSIS_NOT_IN}) THEN 1 ELSE 0 END), m.updated_at DESC`,
      ).all(embeddings.model) as {
        id: number;
        category: string;
        subject: string;
        content: string;
        had_vector: number;
      }[];

      if (rows.length > 0) {
        logger.info(`Embedding backfill: ${rows.length} memories need ${embeddings.model} vectors`);
      }

      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const inputs = batch.map((row) => buildEmbeddingInput(row));

        try {
          const vectors = await embeddings.embed(inputs, 'document');
          if (vectors.length !== batch.length) {
            throw new Error(`Embeddings API returned ${vectors.length} vectors for ${batch.length} inputs`);
          }

          this.runInTransaction(() => {
            for (let j = 0; j < batch.length; j++) {
              const row = batch[j];
              // Staleness check: while we awaited the API, a concurrent save() may have changed this
              // memory's content (its own phase-2 already embedded the new text), or it may have been
              // deactivated/removed. Never overwrite fresher data with a stale vector.
              const current = this.stmt('SELECT category, subject, content, active FROM memories WHERE id = ?').get(
                row.id,
              ) as Pick<Memory, 'category' | 'subject' | 'content' | 'active'> | undefined;
              if (!current || current.active !== 1) continue;
              if (buildEmbeddingInput(current) !== inputs[j]) continue;

              this.upsertVector(row.id, embeddings.model, inputs[j], vectors[j], {
                category: current.category,
                subject: current.subject,
              });
              if (row.had_vector) {
                counts.reembedded++;
              } else {
                counts.embedded++;
              }
            }
          });
        } catch (error) {
          counts.failed += batch.length;
          logger.warn(`Embedding backfill: batch of ${batch.length} failed (will retry next run):`, error);
        }
      }

      // Contract step: prune old-model vectors for memories that now have a current-model vector.
      // Runs even when nothing needed embedding this run — if a previous run died between its last
      // batch and this prune, the leftover old-model vectors are healed here instead of persisting
      // until the next model switch.
      const pruned = this.stmt(
        `DELETE FROM memory_embeddings WHERE model != ?
         AND memory_id IN (SELECT memory_id FROM memory_embeddings WHERE model = ?)`,
      ).run(embeddings.model, embeddings.model);
      if (pruned.changes > 0) {
        logger.info(`Embedding backfill: pruned ${pruned.changes} superseded old-model vector(s)`);
        // The cache only holds current-model vectors, so pruning can't affect it — invalidate anyway
        // as a cheap defense against that assumption ever changing.
        this.invalidateVectorCache();
      }

      return counts;
    } finally {
      this.backfillInFlight = false;
    }
  }

  // ---- Embedding vector internals ----

  /**
   * Returns the in-memory vector cache for the given model, cold-loading it from SQLite if needed
   * (~32ms at real prod scale). The cache mirrors exactly: active memories × current-model vectors.
   */
  private getVectorCache(model: string): Map<number, CachedVector> {
    if (this.vectorCache && this.vectorCacheModel === model) return this.vectorCache;

    const rows = this.stmt(
      `SELECT e.memory_id, e.vector, m.category, m.subject FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE e.model = ? AND m.active = 1`,
    ).all(model) as { memory_id: number; vector: Buffer; category: string; subject: string }[];

    this.vectorCache = new Map(
      rows.map((r) => [r.memory_id, { vec: blobToVector(r.vector), category: r.category, subject: r.subject }]),
    );
    this.vectorCacheModel = model;
    return this.vectorCache;
  }

  /** Drops the vector cache; the next access reloads it from SQLite. For bulk/batch vector changes. */
  private invalidateVectorCache(): void {
    this.vectorCache = null;
    this.vectorCacheModel = null;
  }

  /**
   * Inserts or replaces the vector for (memoryId, model), storing the exact embedded text alongside it.
   * Write-through: the in-memory cache is updated in the same call so it can never drift from the DB.
   */
  private upsertVector(
    memoryId: number,
    model: string,
    inputText: string,
    vector: Float32Array,
    meta: { category: string; subject: string },
  ): void {
    this.stmt(
      `INSERT INTO memory_embeddings (memory_id, model, dims, input_text, vector)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(memory_id, model) DO UPDATE SET
         dims = excluded.dims,
         input_text = excluded.input_text,
         vector = excluded.vector,
         created_at = datetime('now')`,
    ).run(memoryId, model, vector.length, inputText, vectorToBlob(vector));

    if (this.vectorCache) {
      if (this.vectorCacheModel === model) {
        this.vectorCache.set(memoryId, { vec: vector, category: meta.category, subject: meta.subject });
      } else {
        // Shouldn't happen (one model per store instance), but never leave a stale cache behind.
        this.invalidateVectorCache();
      }
    }
  }

  /** Deletes all stored vectors (every model) for a memory. Write-through to the cache. */
  private deleteVectors(memoryId: number): void {
    this.stmt('DELETE FROM memory_embeddings WHERE memory_id = ?').run(memoryId);
    this.vectorCache?.delete(memoryId);
  }

  // ---- Learner state methods ----

  getLastObserved(channelId: string): string | null {
    const row = this.stmt('SELECT last_message_id FROM learner_state WHERE channel_id = ?').get(channelId) as
      | { last_message_id: string }
      | undefined;
    return row?.last_message_id ?? null;
  }

  setLastObserved(channelId: string, messageId: string): void {
    this.stmt(
      `INSERT INTO learner_state (channel_id, last_message_id, last_observed_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(channel_id) DO UPDATE SET last_message_id = ?, last_observed_at = datetime('now')`,
    ).run(channelId, messageId, messageId);
  }

  // ---- Generic key/value state (digest watermark, last-announced deploy sha, etc.) ----

  getState(key: string): string | undefined {
    const row = this.stmt('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.stmt(
      `INSERT INTO bot_state (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value);
  }

  // ---- Identity methods ----

  upsertIdentity(discordUserId: string, displayName: string): void {
    // Insert if new (canonical_name = displayName at time of first seen); otherwise refresh display_name.
    this.stmt(
      `INSERT INTO identities (discord_user_id, display_name, canonical_name, first_seen_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(discord_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = CASE WHEN identities.display_name = excluded.display_name THEN identities.updated_at ELSE datetime('now') END`,
    ).run(discordUserId, displayName, displayName);
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

    this.stmt(
      `UPDATE identities
       SET irl_name = ?, aliases = ?, updated_at = datetime('now')
       WHERE discord_user_id = ?`,
    ).run(nextIrl, JSON.stringify(nextAliases), discordUserId);

    return true;
  }

  getIdentityById(discordUserId: string): Identity | undefined {
    const row = this.stmt('SELECT * FROM identities WHERE discord_user_id = ?').get(discordUserId) as
      | (Omit<Identity, 'aliases'> & { aliases: string })
      | undefined;

    if (!row) return undefined;
    return { ...row, aliases: this.parseAliases(row.aliases) };
  }

  getAllIdentities(): Identity[] {
    const rows = this.stmt('SELECT * FROM identities ORDER BY canonical_name ASC').all() as (Omit<
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

  // ---- Emoji methods ----

  upsertEmoji(emoji: EmojiUpsertInput): { inserted: boolean; nameChanged: boolean } {
    const existing = this.stmt('SELECT name, active FROM emojis WHERE id = ?').get(emoji.id) as
      | { name: string; active: number }
      | undefined;

    if (!existing) {
      this.stmt('INSERT INTO emojis (id, name, animated, active) VALUES (?, ?, ?, 1)').run(
        emoji.id,
        emoji.name,
        emoji.animated ? 1 : 0,
      );
      return { inserted: true, nameChanged: false };
    }

    const nameChanged = existing.name !== emoji.name;
    if (nameChanged || existing.active !== 1) {
      this.stmt('UPDATE emojis SET name = ?, animated = ?, active = 1 WHERE id = ?').run(
        emoji.name,
        emoji.animated ? 1 : 0,
        emoji.id,
      );
    }
    return { inserted: false, nameChanged };
  }

  setEmojiCaption(id: string, caption: string): void {
    this.stmt("UPDATE emojis SET caption = ?, captioned_at = datetime('now') WHERE id = ?").run(caption, id);
  }

  deactivateEmoji(id: string): void {
    this.stmt('UPDATE emojis SET active = 0 WHERE id = ?').run(id);
  }

  getEmojiById(id: string): EmojiRow | undefined {
    return this.stmt('SELECT * FROM emojis WHERE id = ?').get(id) as EmojiRow | undefined;
  }

  getUsableEmojis(): EmojiRow[] {
    return this.stmt('SELECT * FROM emojis WHERE active = 1 ORDER BY use_count DESC, name ASC').all() as EmojiRow[];
  }

  incrementEmojiUsage(id: string, by = 1): boolean {
    const result = this.stmt(
      "UPDATE emojis SET use_count = use_count + ?, last_used_at = datetime('now') WHERE id = ? AND active = 1",
    ).run(by, id);
    return result.changes > 0;
  }

  clearAllEmojiCaptions(): number {
    const result = this.stmt('UPDATE emojis SET caption = NULL, captioned_at = NULL').run();
    return result.changes;
  }

  getEmojisNeedingCaption(): EmojiRow[] {
    return this.stmt("SELECT * FROM emojis WHERE active = 1 AND (caption IS NULL OR caption = '')").all() as EmojiRow[];
  }

  /** Closes the underlying database handle (graceful shutdown). */
  close(): void {
    this.db.close();
  }

  // ---- Internals ----

  /** Returns the cached prepared statement for this SQL, compiling it on first use. */
  private stmt(sql: string): Database.Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  /**
   * Runs fn inside a transaction (BEGIN/COMMIT, rollback on throw). Nested calls become savepoints,
   * so transactional helpers can safely call each other.
   */
  private runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private addColumnIfMissing(table: string, column: string, columnDef: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef};`);
  }
}
