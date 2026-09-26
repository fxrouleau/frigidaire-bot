// Memory v2 notes (docs/memory.md): per-person markdown notes (a `profile` plus topic notes) and the
// group's notes, derived from the journal (the `memories` table) by the nightly dream, owner edits and the
// bootstrap. The journal stays the source of truth; notes can always be regenerated from it.
//
// Tables live in memory.db next to the journal, on the MemoryStore's handle:
//   notes          one row per (scope, owner, topic): the current version. The group's owner_id is ''.
//   note_versions  every version ever written, the current one included (undo restores the previous one).
//   notes_fts      a plain (not external-content) FTS5 table over active notes, kept by triggers on
//                  `notes` alone, so it is correct by construction: a DELETE of a missing row is harmless
//                  here, unlike the external-content 'delete' command that once corrupted memories_fts.
//   dream_state    per owner: the journal watermark (the highest journal_seq folded into the notes), when
//                  the last dream ran and its last error.
//
// Every write goes through writeNotes()/undo(): validated first (schema.ts), then all-or-nothing in one
// transaction. Nothing is ever hard-deleted: removing a topic deactivates it and records a version.
import type Database from 'better-sqlite3';
import { accountIdsFor, canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import {
  CORRECTION_CATEGORY,
  IDENTITY_NAME_TIERS,
  type Memory,
  type MemoryStore,
  NON_PERSON_SUBJECTS,
  SELF_DIAGNOSIS_CATEGORIES,
} from '../memoryStore';
import { STOP_WORDS } from '../wordOverlap';
import {
  maxTopicsFor,
  type NoteDraft,
  type NoteOwner,
  type NoteScope,
  type NoteUpdatedBy,
  normalizeTopic,
  PROFILE_TOPIC,
  validateNoteDraft,
} from './schema';

/** The current version of one note. */
export type Note = {
  id: number;
  scope: NoteScope;
  /** The person's main account id; null for the group. */
  ownerId: string | null;
  topic: string;
  title: string;
  /** Markdown. */
  content: string;
  version: number;
  /** SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS"), like every memory.db timestamp. */
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  active: boolean;
};

/** One stored version of a note (the current one included). */
export type NoteVersion = {
  noteId: number;
  version: number;
  title: string;
  content: string;
  /** False for the version that removed the topic. */
  active: boolean;
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  /** Why: the dream's change summary, the owner's edit instruction, "undo of v3", … */
  reason: string | null;
};

export type WriteNotesOptions = {
  updatedBy: NoteUpdatedBy;
  /** Stored on every version this write creates. */
  reason?: string;
  /** Topics to remove (deactivate). A person's profile can never be removed. */
  removeTopics?: string[];
  /**
   * Discord ids the note text may contain besides the person's own account ids (ids that were in the
   * writer's input). See NoteValidationContext.
   */
  allowedIds?: Iterable<string>;
};

export type WriteNotesResult =
  | {
      ok: true;
      /** Notes created or changed by this write (their new current version). */
      written: Note[];
      /** Notes this write deactivated. */
      removed: Note[];
      /** Topics whose draft matched the current version exactly (no new version). */
      unchanged: string[];
    }
  | { ok: false; errors: string[] };

export type UndoResult = { ok: true; note: Note } | { ok: false; error: string };

export type NoteSearchHit = { note: Note; snippet: string };

export type DreamState = {
  /** The highest journal_seq whose rows are folded into this owner's notes (0: none yet). */
  journalWatermark: number;
  /** SQLite UTC timestamp of the last successful dream, or null. */
  lastDreamAt: string | null;
  lastError: string | null;
};

/** Whose journal rows: a person (optionally with the names to match name-only rows by) or the group. */
export type JournalOwner = { scope: 'person'; ownerId: string; names?: string[] } | { scope: 'group' };

export type JournalOptions = {
  /** Only the newest this many rows (still returned oldest first). */
  limit?: number;
  /** 'observations' leaves corrections out, 'corrections' keeps only them. Default 'all'. */
  kinds?: 'all' | 'observations' | 'corrections';
};

/** An owner with journal rows above their watermark (see pendingDreams()). */
export type PendingDream = { owner: NoteOwner; newRows: number; latestSeq: number };

export type NotesStoreOptions = {
  /** Clock for version timestamps (tests pin it). */
  now?: () => Date;
};

type NoteRow = {
  id: number;
  scope: NoteScope;
  owner_id: string;
  topic: string;
  title: string;
  content: string;
  version: number;
  updated_at: string;
  updated_by: NoteUpdatedBy;
  active: number;
};

type VersionRow = {
  note_id: number;
  version: number;
  title: string;
  content: string;
  active: number;
  updated_at: string;
  updated_by: NoteUpdatedBy;
  reason: string | null;
};

const SELF_DIAGNOSIS_NOT_IN = SELF_DIAGNOSIS_CATEGORIES.map((c) => `'${c}'`).join(', ');
// The group's journal: rows about the server as a whole ('bot' rows are about the bot itself).
const GROUP_SUBJECTS = JSON.stringify([...NON_PERSON_SUBJECTS].filter((s) => s !== 'bot'));
const MAX_REASON_CHARS = 4_000;

/** "2026-09-25 14:03:00": the SQLite UTC format every memory.db timestamp uses. */
export function toSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function ownerKey(owner: NoteOwner): { scope: NoteScope; ownerId: string } {
  return owner.scope === 'group' ? { scope: 'group', ownerId: '' } : { scope: 'person', ownerId: owner.ownerId };
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.scope === 'group' ? null : row.owner_id,
    topic: row.topic,
    title: row.title,
    content: row.content,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    active: row.active === 1,
  };
}

function toVersion(row: VersionRow): NoteVersion {
  return {
    noteId: row.note_id,
    version: row.version,
    title: row.title,
    content: row.content,
    active: row.active === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
  };
}

/** The owner a note belongs to. */
export function ownerOf(note: Pick<Note, 'scope' | 'ownerId'>): NoteOwner {
  return note.scope === 'group' || note.ownerId === null
    ? { scope: 'group' }
    : { scope: 'person', ownerId: note.ownerId };
}

/** Profile first, then topics alphabetically. */
function byTopic(a: Pick<Note, 'topic'>, b: Pick<Note, 'topic'>): number {
  if (a.topic === b.topic) return 0;
  if (a.topic === PROFILE_TOPIC) return -1;
  if (b.topic === PROFILE_TOPIC) return 1;
  return a.topic < b.topic ? -1 : 1;
}

export class NotesStore {
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();
  private readonly now: () => Date;

  constructor(
    private readonly memory: MemoryStore,
    opts: NotesStoreOptions = {},
  ) {
    this.db = memory.sharedDatabase();
    this.now = opts.now ?? (() => new Date());
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope       TEXT    NOT NULL CHECK (scope IN ('person', 'group')),
        owner_id    TEXT    NOT NULL DEFAULT '',
        topic       TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        version     INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_by  TEXT    NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        UNIQUE (scope, owner_id, topic),
        CHECK ((scope = 'group') = (owner_id = ''))
      );

      CREATE TABLE IF NOT EXISTS note_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        title       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        active      INTEGER NOT NULL,
        updated_at  TEXT    NOT NULL,
        updated_by  TEXT    NOT NULL,
        reason      TEXT,
        UNIQUE (note_id, version)
      );

      CREATE TABLE IF NOT EXISTS dream_state (
        scope             TEXT    NOT NULL CHECK (scope IN ('person', 'group')),
        owner_id          TEXT    NOT NULL DEFAULT '',
        journal_watermark INTEGER NOT NULL DEFAULT 0,
        last_dream_at     TEXT,
        last_error        TEXT,
        updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (scope, owner_id)
      ) WITHOUT ROWID;
    `);

    // A plain FTS5 table (it stores its own copy of title/content): the triggers below are its only
    // writers, and DELETE by rowid is a no-op for a row that isn't there.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes WHEN new.active = 1
      BEGIN
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes
      BEGIN
        DELETE FROM notes_fts WHERE rowid = old.id;
        INSERT INTO notes_fts(rowid, title, content) SELECT new.id, new.title, new.content WHERE new.active = 1;
      END;

      CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes
      BEGIN
        DELETE FROM notes_fts WHERE rowid = old.id;
      END;
    `);
  }

  // ---- Reading notes ----

  /** The owner's active note on a topic. */
  getNote(owner: NoteOwner, topic: string): Note | undefined {
    const { scope, ownerId } = ownerKey(owner);
    const row = this.stmt('SELECT * FROM notes WHERE scope = ? AND owner_id = ? AND topic = ? AND active = 1').get(
      scope,
      ownerId,
      topic,
    ) as NoteRow | undefined;
    return row ? toNote(row) : undefined;
  }

  /** A person's profile note (their main account id; a side account's id resolves to it). */
  getProfile(userId: string): Note | undefined {
    return this.getNote({ scope: 'person', ownerId: canonicalUserId(userId) }, PROFILE_TOPIC);
  }

  /** A note by id, active or not (the viewer's buttons carry ids). */
  getNoteById(id: number): Note | undefined {
    const row = this.stmt('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? toNote(row) : undefined;
  }

  /** The owner's active notes, profile first, then topics alphabetically. */
  listNotes(owner: NoteOwner): Note[] {
    const { scope, ownerId } = ownerKey(owner);
    const rows = this.stmt('SELECT * FROM notes WHERE scope = ? AND owner_id = ? AND active = 1').all(
      scope,
      ownerId,
    ) as NoteRow[];
    return rows.map(toNote).sort(byTopic);
  }

  /** Every active note of every owner (people by owner id, the group last), each owner's profile first. */
  listAllNotes(): Note[] {
    const rows = this.stmt('SELECT * FROM notes WHERE active = 1').all() as NoteRow[];
    return rows.map(toNote).sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'person' ? -1 : 1;
      if (a.ownerId !== b.ownerId) return (a.ownerId ?? '') < (b.ownerId ?? '') ? -1 : 1;
      return byTopic(a, b);
    });
  }

  /** Whether the person has any notes yet (people without fall back to plain journal rows). */
  hasNotes(owner: NoteOwner): boolean {
    const { scope, ownerId } = ownerKey(owner);
    return (
      this.stmt('SELECT 1 FROM notes WHERE scope = ? AND owner_id = ? AND active = 1 LIMIT 1').get(scope, ownerId) !==
      undefined
    );
  }

  /** Every version of a note, newest first. */
  getVersions(noteId: number, limit = 50): NoteVersion[] {
    const rows = this.stmt('SELECT * FROM note_versions WHERE note_id = ? ORDER BY version DESC LIMIT ?').all(
      noteId,
      limit,
    ) as VersionRow[];
    return rows.map(toVersion);
  }

  /** One version of a note. */
  getVersion(noteId: number, version: number): NoteVersion | undefined {
    const row = this.stmt('SELECT * FROM note_versions WHERE note_id = ? AND version = ?').get(noteId, version) as
      | VersionRow
      | undefined;
    return row ? toVersion(row) : undefined;
  }

  /**
   * Full-text search over active notes (titles and content), best matches first: notes matching every
   * term, then notes matching any meaningful term. Each hit carries a short snippet with the matches in
   * **bold**. Optionally limited to one owner.
   */
  searchNotes(query: string, opts: { limit?: number; owner?: NoteOwner } = {}): NoteSearchHit[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const terms = [...new Set(query.replace(/["',(){}*:^~@!#$%&+\-.?;[\]<>/\\|=]/g, ' ').split(/\s+/))].filter(
      (t) => t.length > 1,
    );
    if (terms.length === 0) return [];
    const all = terms.map((t) => `"${t}"`).join(' ');
    const meaningful = terms.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
    const any = meaningful.map((t) => `"${t}"`).join(' OR ');

    const hits: NoteSearchHit[] = [];
    const seen = new Set<number>();
    for (const expression of [all, ...(terms.length > 1 && any ? [any] : [])]) {
      for (const hit of this.matchNotes(expression, limit * 2)) {
        if (seen.has(hit.note.id)) continue;
        if (opts.owner && !this.belongsTo(hit.note, opts.owner)) continue;
        seen.add(hit.note.id);
        hits.push(hit);
      }
      if (hits.length >= limit) break;
    }
    return hits.slice(0, limit);
  }

  private matchNotes(expression: string, limit: number): NoteSearchHit[] {
    try {
      const rows = this.stmt(
        `SELECT n.*, snippet(notes_fts, 1, '**', '**', '…', 16) AS snippet
         FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.active = 1
         ORDER BY rank LIMIT ?`,
      ).all(expression, limit) as (NoteRow & { snippet: string })[];
      return rows.map((row) => ({ note: toNote(row), snippet: row.snippet.replace(/\s+/g, ' ').trim() }));
    } catch (error) {
      logger.warn('notes: search failed:', error);
      return [];
    }
  }

  private belongsTo(note: Note, owner: NoteOwner): boolean {
    const key = ownerKey(owner);
    return note.scope === key.scope && (note.ownerId ?? '') === key.ownerId;
  }

  // ---- Writing notes ----

  /**
   * Writes some of an owner's notes (and removes others) as new versions, all or nothing. Every draft is
   * validated (schema.ts: slug, title, size, no Discord markup/HTML/foreign ids); the result must keep the
   * owner within their topic limit, and a person with any notes must have a profile. A draft identical to
   * the current version creates no version. Returns the errors instead of throwing; nothing is written
   * then.
   */
  writeNotes(owner: NoteOwner, drafts: NoteDraft[], opts: WriteNotesOptions): WriteNotesResult {
    const { scope, ownerId } = ownerKey(owner);
    const errors: string[] = [];
    if (scope === 'person' && (!ownerId || /\s/.test(ownerId) || ownerId.length > 32)) {
      return { ok: false, errors: ['a person is written by their Discord id'] };
    }
    if (scope === 'person' && canonicalUserId(ownerId) !== ownerId) {
      return { ok: false, errors: [`${ownerId} is a linked side account: notes belong to its main account`] };
    }

    const allowedIds = [...(opts.allowedIds ?? []), ...(scope === 'person' ? accountIdsFor(ownerId) : [])];
    const valid: NoteDraft[] = [];
    for (const draft of drafts) {
      const result = validateNoteDraft(draft, { scope, allowedIds });
      if (!result.ok) errors.push(...result.errors);
      else if (valid.some((v) => v.topic === result.value.topic))
        errors.push(`topic "${result.value.topic}" appears twice`);
      else valid.push(result.value);
    }

    const removeTopics: string[] = [];
    for (const raw of opts.removeTopics ?? []) {
      const topic = normalizeTopic(raw);
      if (!topic) errors.push(`removed topic "${String(raw).slice(0, 40)}" is not a topic slug`);
      else if (scope === 'person' && topic === PROFILE_TOPIC) errors.push('the profile can never be removed');
      else if (valid.some((v) => v.topic === topic)) errors.push(`topic "${topic}" is both written and removed`);
      else if (!removeTopics.includes(topic)) removeTopics.push(topic);
    }
    if (errors.length > 0) return { ok: false, errors };

    const reason = opts.reason ? opts.reason.slice(0, MAX_REASON_CHARS) : null;
    const at = toSqliteUtc(this.now());
    try {
      return this.runInTransaction(() => {
        const current = new Map(this.listNotes(owner).map((n) => [n.topic, n]));
        const after = new Set(current.keys());
        for (const draft of valid) after.add(draft.topic);
        for (const topic of removeTopics) after.delete(topic);
        const limit = maxTopicsFor(scope);
        if (after.size > limit) throw new WriteRefused(`${after.size} topics, over the limit of ${limit}`);
        if (scope === 'person' && after.size > 0 && !after.has(PROFILE_TOPIC)) {
          throw new WriteRefused('a person\'s notes must include the "profile" topic');
        }

        const written: Note[] = [];
        const unchanged: string[] = [];
        for (const draft of valid) {
          const existing = this.anyNote(scope, ownerId, draft.topic);
          if (existing?.active && existing.title === draft.title && existing.content === draft.content) {
            unchanged.push(draft.topic);
            continue;
          }
          written.push(
            this.putVersion(scope, ownerId, draft.topic, existing, {
              title: draft.title,
              content: draft.content,
              active: true,
              at,
              updatedBy: opts.updatedBy,
              reason,
            }),
          );
        }

        const removed: Note[] = [];
        for (const topic of removeTopics) {
          const existing = current.get(topic);
          if (!existing) continue;
          removed.push(
            this.putVersion(scope, ownerId, topic, existing, {
              title: existing.title,
              content: existing.content,
              active: false,
              at,
              updatedBy: opts.updatedBy,
              reason,
            }),
          );
        }
        return { ok: true as const, written, removed, unchanged };
      });
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, errors: [error.message] };
      throw error;
    }
  }

  /**
   * Restores the version before a note's current one as a new version (updated_by 'undo'): its title,
   * content and whether it was active. Undoing twice restores what the first undo replaced. Refused for
   * a note with no earlier version, and when bringing a removed topic back would pass the topic limit.
   */
  undo(noteId: number, opts: { reason?: string } = {}): UndoResult {
    const note = this.getNoteById(noteId);
    if (!note) return { ok: false, error: 'no such note' };
    const previous = this.getVersion(noteId, note.version - 1);
    if (!previous) return { ok: false, error: 'there is no earlier version to go back to' };

    const { scope, ownerId } = ownerKey(ownerOf(note));
    if (previous.active && !note.active && this.listNotes(ownerOf(note)).length >= maxTopicsFor(scope)) {
      return { ok: false, error: 'bringing that topic back would pass the topic limit' };
    }
    const restored = this.runInTransaction(() =>
      this.putVersion(scope, ownerId, note.topic, note, {
        title: previous.title,
        content: previous.content,
        active: previous.active,
        at: toSqliteUtc(this.now()),
        updatedBy: 'undo',
        reason: (opts.reason ?? `undo of v${note.version} (back to v${previous.version})`).slice(0, MAX_REASON_CHARS),
      }),
    );
    return { ok: true, note: restored };
  }

  /** Rebuilds the notes FTS index from the active notes (belt and braces; the triggers keep it right). */
  rebuildFtsIndex(): number {
    return this.runInTransaction(() => {
      this.stmt('DELETE FROM notes_fts').run();
      return this.stmt(
        'INSERT INTO notes_fts(rowid, title, content) SELECT id, title, content FROM notes WHERE active = 1',
      ).run().changes;
    });
  }

  private anyNote(scope: NoteScope, ownerId: string, topic: string): Note | undefined {
    const row = this.stmt('SELECT * FROM notes WHERE scope = ? AND owner_id = ? AND topic = ?').get(
      scope,
      ownerId,
      topic,
    ) as NoteRow | undefined;
    return row ? toNote(row) : undefined;
  }

  /** Writes the next version of a note (creating it at v1) and records it in note_versions. In a transaction. */
  private putVersion(
    scope: NoteScope,
    ownerId: string,
    topic: string,
    existing: Note | undefined,
    next: {
      title: string;
      content: string;
      active: boolean;
      at: string;
      updatedBy: NoteUpdatedBy;
      reason: string | null;
    },
  ): Note {
    let id: number;
    let version: number;
    if (existing) {
      id = existing.id;
      version = existing.version + 1;
      this.stmt(
        `UPDATE notes SET title = ?, content = ?, version = ?, updated_at = ?, updated_by = ?, active = ?
         WHERE id = ?`,
      ).run(next.title, next.content, version, next.at, next.updatedBy, next.active ? 1 : 0, id);
    } else {
      version = 1;
      id = Number(
        this.stmt(
          `INSERT INTO notes (scope, owner_id, topic, title, content, version, updated_at, updated_by, active)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(scope, ownerId, topic, next.title, next.content, next.at, next.updatedBy, next.active ? 1 : 0)
          .lastInsertRowid,
      );
    }
    this.stmt(
      `INSERT INTO note_versions (note_id, version, title, content, active, updated_at, updated_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, version, next.title, next.content, next.active ? 1 : 0, next.at, next.updatedBy, next.reason);
    const note = this.getNoteById(id);
    if (!note) throw new Error(`note #${id} vanished while it was written`);
    return note;
  }

  // ---- The journal (the memories table) ----

  /** The journal clock's current value: the highest journal_seq of any row (0 for an empty journal). */
  journalHighWater(): number {
    const row = this.stmt('SELECT COALESCE(MAX(journal_seq), 0) AS seq FROM memories').get() as { seq: number };
    return row.seq;
  }

  /**
   * An owner's active journal rows with journal_seq above `afterSeq`, oldest first (by journal_seq).
   * A person's rows are the ones stamped with any of their account ids, plus rows filed under one of
   * their names that carry no id (getForPerson's rule: a shared name never claims another member's rows).
   * The group's rows are the ones about the server as a whole. Self-diagnosis rows are never included.
   */
  journalSince(owner: JournalOwner, afterSeq: number, opts: JournalOptions = {}): Memory[] {
    const kinds = opts.kinds ?? 'all';
    const kindFilter =
      kinds === 'corrections'
        ? `AND category = '${CORRECTION_CATEGORY}'`
        : kinds === 'observations'
          ? `AND category != '${CORRECTION_CATEGORY}'`
          : '';
    const limit = opts.limit !== undefined ? Math.max(0, Math.floor(opts.limit)) : -1;

    let rows: Memory[];
    if (owner.scope === 'group') {
      rows = this.stmt(
        `SELECT * FROM (
           SELECT * FROM memories
           WHERE active = 1 AND journal_seq > ? AND subject_user_id IS NULL
             AND lower(subject) IN (SELECT value FROM json_each(?))
             AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) ${kindFilter}
           ORDER BY journal_seq DESC LIMIT ?
         ) ORDER BY journal_seq ASC`,
      ).all(afterSeq, GROUP_SUBJECTS, limit) as Memory[];
    } else {
      const ids = accountIdsFor(owner.ownerId);
      const names = owner.names ?? this.namesOf(ids);
      rows = this.stmt(
        `SELECT * FROM (
           SELECT * FROM memories
           WHERE active = 1 AND journal_seq > ?
             AND (subject_user_id IN (SELECT value FROM json_each(?))
                  OR (subject_user_id IS NULL AND subject IN (SELECT value FROM json_each(?))))
             AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) ${kindFilter}
           ORDER BY journal_seq DESC LIMIT ?
         ) ORDER BY journal_seq ASC`,
      ).all(afterSeq, JSON.stringify(ids), JSON.stringify(names), limit) as Memory[];
    }
    return rows;
  }

  /** The owner's journal rows the notes don't reflect yet (above their watermark). */
  newJournal(owner: JournalOwner, opts: JournalOptions = {}): Memory[] {
    return this.journalSince(owner, this.getDreamState(owner).journalWatermark, opts);
  }

  /** Corrections about the owner that no dream has folded in yet: shown next to the notes until then. */
  openCorrections(owner: JournalOwner, limit = 20): Memory[] {
    return this.newJournal(owner, { kinds: 'corrections', limit });
  }

  /**
   * Owners with journal rows above their watermark, most recently active first: people (by the id their
   * rows are stamped with; name-only rows get an id from the startup stamp) and the group. `limit` caps
   * the people.
   */
  pendingDreams(opts: { limit?: number } = {}): { people: PendingDream[]; group?: PendingDream } {
    const rows = this.stmt(
      `SELECT m.subject_user_id AS uid, COUNT(*) AS n, MAX(m.journal_seq) AS latest
       FROM memories m
       LEFT JOIN dream_state d ON d.scope = 'person' AND d.owner_id = m.subject_user_id
       WHERE m.active = 1 AND m.subject_user_id IS NOT NULL
         AND m.category NOT IN (${SELF_DIAGNOSIS_NOT_IN})
         AND m.journal_seq > COALESCE(d.journal_watermark, 0)
       GROUP BY m.subject_user_id`,
    ).all() as { uid: string; n: number; latest: number }[];

    // A row still stamped with a side account's id counts for the main account.
    const byOwner = new Map<string, { newRows: number; latestSeq: number }>();
    for (const row of rows) {
      const main = canonicalUserId(row.uid);
      const entry = byOwner.get(main) ?? { newRows: 0, latestSeq: 0 };
      entry.newRows += row.n;
      entry.latestSeq = Math.max(entry.latestSeq, row.latest);
      byOwner.set(main, entry);
    }
    const people: PendingDream[] = [...byOwner.entries()]
      .map(([ownerId, entry]) => ({ owner: { scope: 'person' as const, ownerId }, ...entry }))
      .sort((a, b) => b.latestSeq - a.latestSeq)
      .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);

    const groupRows = this.newJournal({ scope: 'group' });
    const group =
      groupRows.length > 0
        ? {
            owner: { scope: 'group' as const },
            newRows: groupRows.length,
            latestSeq: Math.max(...groupRows.map((r) => r.journal_seq ?? 0)),
          }
        : undefined;
    return { people, ...(group ? { group } : {}) };
  }

  /** Every name any of these accounts goes by (display, handle, first-seen, IRL, nicknames). */
  private namesOf(accountIds: string[]): string[] {
    const names = new Set<string>();
    for (const id of accountIds) {
      const identity = this.memory.getIdentityById(id);
      if (!identity) continue;
      for (const tier of IDENTITY_NAME_TIERS) {
        for (const name of tier(identity)) {
          const trimmed = name?.trim();
          if (trimmed) names.add(trimmed);
        }
      }
    }
    return [...names];
  }

  // ---- Dream state ----

  getDreamState(owner: NoteOwner): DreamState {
    const { scope, ownerId } = ownerKey(owner);
    const row = this.stmt(
      'SELECT journal_watermark, last_dream_at, last_error FROM dream_state WHERE scope = ? AND owner_id = ?',
    ).get(scope, ownerId) as
      | { journal_watermark: number; last_dream_at: string | null; last_error: string | null }
      | undefined;
    return {
      journalWatermark: row?.journal_watermark ?? 0,
      lastDreamAt: row?.last_dream_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  /**
   * A dream folded the owner's journal up to `watermark` into their notes: the watermark moves there (never
   * backwards), the last error clears and last_dream_at is stamped.
   */
  recordDreamSuccess(owner: NoteOwner, watermark: number): void {
    const { scope, ownerId } = ownerKey(owner);
    const at = toSqliteUtc(this.now());
    this.stmt(
      `INSERT INTO dream_state (scope, owner_id, journal_watermark, last_dream_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT(scope, owner_id) DO UPDATE SET
         journal_watermark = MAX(dream_state.journal_watermark, excluded.journal_watermark),
         last_dream_at = excluded.last_dream_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(scope, ownerId, Math.max(0, Math.floor(watermark)), at, at);
  }

  /** A dream for the owner failed: the watermark stays (retried next night), the error is kept. */
  recordDreamFailure(owner: NoteOwner, error: string): void {
    const { scope, ownerId } = ownerKey(owner);
    const at = toSqliteUtc(this.now());
    this.stmt(
      `INSERT INTO dream_state (scope, owner_id, journal_watermark, last_error, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(scope, owner_id) DO UPDATE SET last_error = excluded.last_error, updated_at = excluded.updated_at`,
    ).run(scope, ownerId, error.slice(0, 1000), at);
  }

  /**
   * Moves several owners' watermarks to `watermark` (never backwards) without stamping a dream: the
   * bootstrap import, whose notes already cover the journal up to its export.
   */
  setWatermarks(owners: NoteOwner[], watermark: number): void {
    const at = toSqliteUtc(this.now());
    const upsert = this.stmt(
      `INSERT INTO dream_state (scope, owner_id, journal_watermark, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, owner_id) DO UPDATE SET
         journal_watermark = MAX(dream_state.journal_watermark, excluded.journal_watermark),
         updated_at = excluded.updated_at`,
    );
    this.runInTransaction(() => {
      for (const owner of owners) {
        const { scope, ownerId } = ownerKey(owner);
        upsert.run(scope, ownerId, Math.max(0, Math.floor(watermark)), at);
      }
    });
  }

  // ---- Internals ----

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

/** A write refused inside the transaction (it rolls back); turned into WriteNotesResult errors. */
class WriteRefused extends Error {}
