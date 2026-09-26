// Memory v2 notes (docs/memory.md): per-person markdown notes (a `profile` plus topic notes), the group's
// notes, and circles (a note shared by a SET of members, with dated membership), derived from the journal
// (the `memories` table) by the nightly dream, owner edits and the bootstrap. The journal stays the source
// of truth; notes can always be regenerated from it.
//
// Tables live in memory.db next to the journal, on the MemoryStore's handle:
//   notes          one row per (scope, owner, topic): the current version. owner_id is the person's main
//                  id, '' for the group and for circles (a circle's topic is its unique slug). Circles
//                  carry `aliases` (JSON array of other names the group uses for them).
//   note_members   a circle's members, dated: (note_id, member_id, since, until, role). until NULL = current.
//   note_versions  every version ever written, the current one included, with a circle's membership
//                  snapshot (undo restores the previous version, membership included).
//   notes_fts      a plain (not external-content) FTS5 table over active notes (title, content, aliases),
//                  kept by triggers on `notes` alone, so it is correct by construction: a DELETE of a
//                  missing row is harmless here, unlike the external-content 'delete' command that once
//                  corrupted memories_fts.
//   dream_state    per person and for the group: the journal watermark (the highest journal_seq folded
//                  into the notes), when the last dream ran and its last error. Circles have none: the
//                  person and group dreams maintain them.
//
// Every write goes through writeNotes()/writeCircles()/applyNotesOutput()/undo(): validated first
// (schema.ts), then all-or-nothing in one transaction. Nothing is ever hard-deleted: removing a topic or a
// circle deactivates it and records a version.
import type Database from 'better-sqlite3';
import { config } from '../../../config';
import { accountIdsFor, canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import { toSqliteUtc } from '../../utils';
import {
  CORRECTION_CATEGORY,
  everyoneGoingBy,
  IDENTITY_NAME_TIERS,
  LEARNER_SOURCES,
  type Memory,
  type MemoryStore,
  NON_PERSON_SUBJECTS,
  SELF_DIAGNOSIS_CATEGORIES,
} from '../memoryStore';
import { STOP_WORDS } from '../wordOverlap';
import {
  type CircleDraft,
  type CircleMember,
  maxTopicsFor,
  NOTE_LIMITS,
  type NoteDraft,
  type NoteOwner,
  type NoteScope,
  type NotesOutput,
  type NoteUpdatedBy,
  normalizeTopic,
  PROFILE_TOPIC,
  validateCircleDraft,
  validateNoteDraft,
} from './schema';

export { toSqliteUtc };

/** The current version of one note (a person's topic, a group topic, or a circle). */
export type Note = {
  id: number;
  scope: NoteScope;
  /** The person's main account id; null for the group and for circles. */
  ownerId: string | null;
  /** The topic slug; a circle's unique slug. */
  topic: string;
  title: string;
  /** Markdown. */
  content: string;
  /** Other names a circle goes by ([] for person and group notes). */
  aliases: string[];
  /** A circle's members, current and former, by main id ([] for person and group notes). */
  members: CircleMember[];
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
  aliases: string[];
  /** A circle's membership as of this version; null for person and group notes. */
  members: CircleMember[] | null;
  /** False for the version that removed the topic or circle. */
  active: boolean;
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  /** Why: the dream's change summary, the owner's edit instruction, "undo of v3", "merged into mtg", … */
  reason: string | null;
};

/** A member's place in a circle. */
export type CircleMembership = { circle: Note; membership: CircleMember };

/** One version written to a person's note or a circle (see NotesStore.changesSince). */
export type NoteChange = {
  noteId: number;
  scope: 'person' | 'circle';
  /** The person's main id; null for a circle. */
  ownerId: string | null;
  /** The topic, or the circle's slug. */
  topic: string;
  title: string;
  version: number;
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  reason: string | null;
};

export type WriteNotesOptions = {
  updatedBy: NoteUpdatedBy;
  /** Stored on every version this write creates. */
  reason?: string;
  /** The owner's topics to remove (deactivate). A person's profile can never be removed. */
  removeTopics?: string[];
  /**
   * Discord ids the note text may contain besides the person's own account ids (ids that were in the
   * writer's input), and that circle membership may name besides members the bot knows (an identities
   * row or a LINKED_ACCOUNTS id). See NoteValidationContext.
   */
  allowedIds?: Iterable<string>;
  /** Circles to create or update in the same transaction (validated like validateCircleDraft). */
  circles?: unknown[];
  /** Circle slugs to remove (deactivate) in the same transaction. */
  removeCircles?: string[];
  /**
   * Only circles this member (main id) is or was in may be written, merged or removed, and a written
   * circle must keep them listed: a person's dream or edit never rewrites circles they aren't part of.
   * writeNotes() sets it to the person for a person's write unless `anyCircle` is set.
   */
  circlesMustInclude?: string;
  /** Lets a person's write touch any circle (owner edits of a circle go through writeCircles instead). */
  anyCircle?: boolean;
};

export type WriteNotesResult =
  | {
      ok: true;
      /** Notes and circles created or changed by this write (their new current version). */
      written: Note[];
      /** Notes and circles this write deactivated (removed, or merged into another circle). */
      removed: Note[];
      /** What matched the current version exactly (no new version): topics, and circles as `circle:<slug>`. */
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
  aliases: string;
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
  aliases: string;
  members: string | null;
  active: number;
  updated_at: string;
  updated_by: NoteUpdatedBy;
  reason: string | null;
};

type MemberRow = {
  note_id: number;
  member_id: string;
  since: string | null;
  until: string | null;
  role: string | null;
};

const SELF_DIAGNOSIS_NOT_IN = SELF_DIAGNOSIS_CATEGORIES.map((c) => `'${c}'`).join(', ');
/** The shape of a Discord id (snowflake). */
const DISCORD_ID = /^\d{15,21}$/;
/** Sources the old learner (and capture) write: the only writers that ever stored an unchecked id. */
const LEARNER_SOURCE_SET: ReadonlySet<string> = new Set(Object.values(LEARNER_SOURCES));
/** Versions pruneVersions() keeps per note by default (the current one included). */
export const NOTE_VERSIONS_KEPT = 50;
/**
 * Writers whose versions pruneVersions() never removes: the bootstrap's notes (the history a rebuild starts
 * from) and the owner's hand edits (the owner's own words).
 */
const KEPT_WRITERS: readonly NoteUpdatedBy[] = ['bootstrap', 'import', 'edit'];
// The group's journal: rows about the server as a whole ('bot' rows are about the bot itself).
const GROUP_SUBJECTS = JSON.stringify([...NON_PERSON_SUBJECTS].filter((s) => s !== 'bot'));
const MAX_REASON_CHARS = 4_000;

function ownerKey(owner: NoteOwner): { scope: NoteScope; ownerId: string } {
  return owner.scope === 'group' ? { scope: 'group', ownerId: '' } : { scope: 'person', ownerId: owner.ownerId };
}

function parseJsonArray<T>(raw: string | null | undefined, guard: (v: unknown) => v is T): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isMember = (v: unknown): v is CircleMember =>
  !!v && typeof v === 'object' && typeof (v as CircleMember).memberId === 'string';

function toMember(row: MemberRow): CircleMember {
  return { memberId: row.member_id, since: row.since, until: row.until, role: row.role };
}

/** Membership in its stored order: current members first, then by joining date, then by id. */
function byMembership(a: CircleMember, b: CircleMember): number {
  if ((a.until === null) !== (b.until === null)) return a.until === null ? -1 : 1;
  const since = (a.since ?? '').localeCompare(b.since ?? '');
  return since !== 0 ? since : a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
}

function sameMembers(a: CircleMember[], b: CircleMember[]): boolean {
  const key = (m: CircleMember[]) => JSON.stringify([...m].sort(byMembership));
  return key(a) === key(b);
}

function toVersion(row: VersionRow): NoteVersion {
  return {
    noteId: row.note_id,
    version: row.version,
    title: row.title,
    content: row.content,
    aliases: parseJsonArray(row.aliases, isString),
    members: row.members === null ? null : parseJsonArray(row.members, isMember),
    active: row.active === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
  };
}

/** The owner a person or group note belongs to; undefined for a circle (see Note.members). */
export function ownerOf(note: Pick<Note, 'scope' | 'ownerId'>): NoteOwner | undefined {
  if (note.scope === 'circle') return undefined;
  return note.scope === 'group' || note.ownerId === null
    ? { scope: 'group' }
    : { scope: 'person', ownerId: note.ownerId };
}

/** Whether a member (main id) is currently in the circle. */
export function isCurrentMember(circle: Pick<Note, 'members'>, memberId: string): boolean {
  return circle.members.some((m) => m.memberId === memberId && m.until === null);
}

/** Profile first, then topics alphabetically. */
function byTopic(a: Pick<Note, 'topic'>, b: Pick<Note, 'topic'>): number {
  if (a.topic === b.topic) return 0;
  if (a.topic === PROFILE_TOPIC) return -1;
  if (b.topic === PROFILE_TOPIC) return 1;
  return a.topic < b.topic ? -1 : 1;
}

const SCOPE_ORDER: Record<NoteScope, number> = { person: 0, group: 1, circle: 2 };

/** A write refused inside the transaction (it rolls back); turned into WriteNotesResult errors. */
class WriteRefused extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}

type VersionInput = {
  title: string;
  content: string;
  aliases: string[];
  /** A circle's full membership (replaces the stored one); null for person and group notes. */
  members: CircleMember[] | null;
  active: boolean;
  at: string;
  updatedBy: NoteUpdatedBy;
  reason: string | null;
};

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
        scope       TEXT    NOT NULL CHECK (scope IN ('person', 'group', 'circle')),
        owner_id    TEXT    NOT NULL DEFAULT '',
        topic       TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        aliases     TEXT    NOT NULL DEFAULT '[]',
        version     INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_by  TEXT    NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        UNIQUE (scope, owner_id, topic),
        CHECK ((scope = 'person') = (owner_id != ''))
      );

      CREATE TABLE IF NOT EXISTS note_members (
        note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        member_id   TEXT    NOT NULL,
        since       TEXT,
        until       TEXT,
        role        TEXT,
        PRIMARY KEY (note_id, member_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_note_members_member ON note_members(member_id);

      CREATE TABLE IF NOT EXISTS note_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        title       TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        aliases     TEXT    NOT NULL DEFAULT '[]',
        members     TEXT,
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

    // A plain FTS5 table (it stores its own copy of title/content/aliases): the triggers below are its
    // only writers, and DELETE by rowid is a no-op for a row that isn't there.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content, aliases,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes WHEN new.active = 1
      BEGIN
        INSERT INTO notes_fts(rowid, title, content, aliases) VALUES (new.id, new.title, new.content, new.aliases);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes
      BEGIN
        DELETE FROM notes_fts WHERE rowid = old.id;
        INSERT INTO notes_fts(rowid, title, content, aliases)
          SELECT new.id, new.title, new.content, new.aliases WHERE new.active = 1;
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
    return row ? this.toNote(row) : undefined;
  }

  /** A person's profile note (their main account id; a side account's id resolves to it). */
  getProfile(userId: string): Note | undefined {
    return this.getNote({ scope: 'person', ownerId: canonicalUserId(userId) }, PROFILE_TOPIC);
  }

  /** A note by id, active or not, any scope (the viewer's buttons carry ids). */
  getNoteById(id: number): Note | undefined {
    const row = this.stmt('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? this.toNote(row) : undefined;
  }

  /** The owner's active notes, profile first, then topics alphabetically (circles: see circlesOf()). */
  listNotes(owner: NoteOwner): Note[] {
    const { scope, ownerId } = ownerKey(owner);
    const rows = this.stmt('SELECT * FROM notes WHERE scope = ? AND owner_id = ? AND active = 1').all(
      scope,
      ownerId,
    ) as NoteRow[];
    return rows.map((r) => this.toNote(r)).sort(byTopic);
  }

  /**
   * Every active note: people's (by owner id, each profile first), then the group's, then circles (by
   * slug).
   */
  listAllNotes(): Note[] {
    const rows = this.stmt('SELECT * FROM notes WHERE active = 1').all() as NoteRow[];
    return rows
      .map((r) => this.toNote(r))
      .sort((a, b) => {
        if (a.scope !== b.scope) return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
        if (a.ownerId !== b.ownerId) return (a.ownerId ?? '') < (b.ownerId ?? '') ? -1 : 1;
        return byTopic(a, b);
      });
  }

  /** Whether the owner has any notes yet (people without fall back to plain journal rows). */
  hasNotes(owner: NoteOwner): boolean {
    const { scope, ownerId } = ownerKey(owner);
    return (
      this.stmt('SELECT 1 FROM notes WHERE scope = ? AND owner_id = ? AND active = 1 LIMIT 1').get(scope, ownerId) !==
      undefined
    );
  }

  /** An active circle by its slug. */
  getCircle(slug: string): Note | undefined {
    const topic = normalizeTopic(slug);
    if (!topic) return undefined;
    const row = this.stmt(
      "SELECT * FROM notes WHERE scope = 'circle' AND owner_id = '' AND topic = ? AND active = 1",
    ).get(topic) as NoteRow | undefined;
    return row ? this.toNote(row) : undefined;
  }

  /**
   * Active circles by title. With `memberId` (any account; its main id is used), only the circles they
   * are currently in, or ever were in with `includeFormer`.
   */
  listCircles(opts: { memberId?: string; includeFormer?: boolean } = {}): Note[] {
    const rows = (
      opts.memberId
        ? this.stmt(
            `SELECT n.* FROM notes n JOIN note_members m ON m.note_id = n.id
             WHERE n.scope = 'circle' AND n.active = 1 AND m.member_id = ? AND (? OR m.until IS NULL)`,
          ).all(canonicalUserId(opts.memberId), opts.includeFormer ? 1 : 0)
        : this.stmt("SELECT * FROM notes WHERE scope = 'circle' AND active = 1").all()
    ) as NoteRow[];
    return rows.map((r) => this.toNote(r)).sort((a, b) => a.title.localeCompare(b.title));
  }

  /** A member's circles (any account; main id used) with their place in each: current ones first, by title. */
  circlesOf(memberId: string, opts: { includeFormer?: boolean } = {}): CircleMembership[] {
    const main = canonicalUserId(memberId);
    return this.listCircles({ memberId: main, includeFormer: opts.includeFormer })
      .map((circle) => ({ circle, membership: circle.members.find((m) => m.memberId === main) }))
      .filter((c): c is CircleMembership => c.membership !== undefined)
      .sort((a, b) => {
        if ((a.membership.until === null) !== (b.membership.until === null))
          return a.membership.until === null ? -1 : 1;
        return a.circle.title.localeCompare(b.circle.title);
      });
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
   * Versions written to people's notes and to circles after `since` (a SQLite UTC timestamp; null = ever),
   * oldest first, at most the newest `limit`: what changed in the members' notes since then (the group
   * pass reads it; see dreamer.ts).
   */
  changesSince(since: string | null, opts: { limit?: number } = {}): NoteChange[] {
    const limit = Math.max(0, Math.floor(opts.limit ?? 500));
    const rows = this.stmt(
      `SELECT * FROM (
         SELECT v.id AS vid, v.note_id, v.version, v.title, v.updated_at, v.updated_by, v.reason,
                n.scope, n.owner_id, n.topic
         FROM note_versions v JOIN notes n ON n.id = v.note_id
         WHERE n.scope IN ('person', 'circle') AND (@since IS NULL OR v.updated_at > @since)
         ORDER BY v.id DESC LIMIT @limit
       ) ORDER BY vid ASC`,
    ).all({ since, limit }) as {
      note_id: number;
      version: number;
      title: string;
      updated_at: string;
      updated_by: NoteUpdatedBy;
      reason: string | null;
      scope: 'person' | 'circle';
      owner_id: string;
      topic: string;
    }[];
    return rows.map((r) => ({
      noteId: r.note_id,
      scope: r.scope,
      ownerId: r.scope === 'person' ? r.owner_id : null,
      topic: r.topic,
      title: r.title,
      version: r.version,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
      reason: r.reason,
    }));
  }

  /**
   * Full-text search over active notes of every scope (titles, content and circle aliases), best matches
   * first: notes matching every term, then notes matching any meaningful term. Each hit carries a short
   * snippet with the matches in **bold**. Optionally limited to one owner or one scope.
   */
  searchNotes(query: string, opts: { limit?: number; owner?: NoteOwner; scope?: NoteScope } = {}): NoteSearchHit[] {
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
      for (const hit of this.matchNotes(expression, limit * 3)) {
        if (seen.has(hit.note.id)) continue;
        if (opts.owner && !this.belongsTo(hit.note, opts.owner)) continue;
        if (opts.scope && hit.note.scope !== opts.scope) continue;
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
        `SELECT n.*, snippet(notes_fts, -1, '**', '**', '…', 16) AS snippet
         FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
         WHERE notes_fts MATCH ? AND n.active = 1
         ORDER BY rank LIMIT ?`,
      ).all(expression, limit) as (NoteRow & { snippet: string })[];
      return rows.map((row) => ({ note: this.toNote(row), snippet: row.snippet.replace(/\s+/g, ' ').trim() }));
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
   * Writes some of an owner's notes (and removes others), plus any circles in `opts.circles` /
   * `opts.removeCircles`, as new versions, all or nothing. Every draft is validated (schema.ts: slug,
   * title, size, no Discord markup/HTML/foreign ids); the result must keep the owner within their topic
   * limit, a person with any notes must have a profile, and circles must stay within the circle limits
   * (writeCircles()). For a person, circles are limited to theirs (WriteNotesOptions.circlesMustInclude)
   * unless `anyCircle`. A draft identical to the current version creates no version. Returns the errors
   * instead of throwing; nothing is written then.
   */
  writeNotes(owner: NoteOwner, drafts: NoteDraft[], opts: WriteNotesOptions): WriteNotesResult {
    const { scope, ownerId } = ownerKey(owner);
    if (scope === 'person' && (!ownerId || /\s/.test(ownerId) || ownerId.length > 32)) {
      return { ok: false, errors: ['a person is written by their Discord id'] };
    }
    if (scope === 'person' && canonicalUserId(ownerId) !== ownerId) {
      return { ok: false, errors: [`${ownerId} is a linked side account: notes belong to its main account`] };
    }
    const circlesMustInclude = opts.circlesMustInclude ?? (scope === 'person' && !opts.anyCircle ? ownerId : undefined);
    return this.write({ owner, drafts, ...opts, circlesMustInclude });
  }

  /**
   * Creates or updates circles (and removes others) as new versions, all or nothing, like writeNotes()
   * without an owner's topics: the group dream, an owner edit of a circle, the bootstrap import. Each
   * circle is validated (validateCircleDraft); member ids resolve to main accounts and must be members
   * the bot knows (an identities row, a LINKED_ACCOUNTS id, or `allowedIds`); `merged_from` circles must
   * exist and are deactivated; at most NOTE_LIMITS.maxCircles active circles, and nobody currently in
   * more than NOTE_LIMITS.maxCirclesPerMember. Membership is replaced by the draft's.
   */
  writeCircles(circles: unknown[], opts: Omit<WriteNotesOptions, 'circles' | 'removeTopics'>): WriteNotesResult {
    return this.write({ drafts: [], ...opts, circles });
  }

  /**
   * Saves a validated writer output (schema.ts NotesOutput: a dream's, an owner edit's, the bootstrap's)
   * for its target: a person or the group (notes + circles), or one circle (an owner edit of a circle:
   * exactly that circle). The version reason defaults to the output's change summary.
   */
  applyNotesOutput(
    target: NoteOwner | { scope: 'circle'; slug: string },
    output: NotesOutput,
    opts: Pick<WriteNotesOptions, 'updatedBy' | 'reason' | 'allowedIds' | 'anyCircle'>,
  ): WriteNotesResult {
    const reason = opts.reason ?? (output.change_summary || undefined);
    if (target.scope === 'circle') {
      const slug = normalizeTopic(target.slug);
      if (output.notes.length > 0 || output.removed_topics.length > 0) {
        return { ok: false, errors: ['an edit of a circle writes only that circle'] };
      }
      if (output.circles.length !== 1 || output.circles[0].slug !== slug || output.removed_circles.length > 0) {
        return { ok: false, errors: [`an edit of circle "${slug ?? target.slug}" writes exactly that circle`] };
      }
      return this.writeCircles(output.circles, { ...opts, reason });
    }
    return this.writeNotes(target, output.notes, {
      ...opts,
      reason,
      removeTopics: output.removed_topics,
      circles: output.circles,
      removeCircles: output.removed_circles,
    });
  }

  /** The write engine behind writeNotes()/writeCircles(). */
  private write(
    plan: WriteNotesOptions & { owner?: NoteOwner; drafts: NoteDraft[]; circlesMustInclude?: string },
  ): WriteNotesResult {
    const owner = plan.owner;
    const key = owner ? ownerKey(owner) : undefined;
    const errors: string[] = [];
    const allowedIds = [...(plan.allowedIds ?? []), ...(key?.scope === 'person' ? accountIdsFor(key.ownerId) : [])];

    const valid: NoteDraft[] = [];
    for (const draft of plan.drafts) {
      if (!key) break;
      const result = validateNoteDraft(draft, { scope: key.scope, allowedIds });
      if (!result.ok) errors.push(...result.errors);
      else if (valid.some((v) => v.topic === result.value.topic))
        errors.push(`topic "${result.value.topic}" appears twice`);
      else valid.push(result.value);
    }

    const removeTopics: string[] = [];
    for (const raw of plan.removeTopics ?? []) {
      const topic = normalizeTopic(raw);
      if (!topic) errors.push(`removed topic "${String(raw).slice(0, 40)}" is not a topic slug`);
      else if (key?.scope === 'person' && topic === PROFILE_TOPIC) errors.push('the profile can never be removed');
      else if (valid.some((v) => v.topic === topic)) errors.push(`topic "${topic}" is both written and removed`);
      else if (!removeTopics.includes(topic)) removeTopics.push(topic);
    }

    const circles: CircleDraft[] = [];
    for (const raw of plan.circles ?? []) {
      const result = validateCircleDraft(raw, { allowedIds });
      if (!result.ok) errors.push(...result.errors);
      else if (circles.some((c) => c.slug === result.value.slug))
        errors.push(`circle "${result.value.slug}" appears twice`);
      else circles.push(result.value);
    }
    const removeCircles: string[] = [];
    for (const raw of plan.removeCircles ?? []) {
      const slug = normalizeTopic(raw);
      if (!slug) errors.push(`removed circle "${String(raw).slice(0, 40)}" is not a slug`);
      else if (circles.some((c) => c.slug === slug || c.merged_from.includes(slug))) {
        errors.push(`circle "${slug}" is both written and removed`);
      } else if (!removeCircles.includes(slug)) removeCircles.push(slug);
    }
    if (errors.length > 0) return { ok: false, errors };

    const reason = plan.reason ? plan.reason.slice(0, MAX_REASON_CHARS) : null;
    const at = toSqliteUtc(this.now());
    const version = (fields: Omit<VersionInput, 'at' | 'updatedBy' | 'reason'>, why = reason): VersionInput => ({
      ...fields,
      at,
      updatedBy: plan.updatedBy,
      reason: why,
    });

    try {
      return this.runInTransaction(() => {
        const written: Note[] = [];
        const removed: Note[] = [];
        const unchanged: string[] = [];

        if (owner && key) {
          const current = new Map(this.listNotes(owner).map((n) => [n.topic, n]));
          const after = new Set(current.keys());
          for (const draft of valid) after.add(draft.topic);
          for (const topic of removeTopics) after.delete(topic);
          const limit = maxTopicsFor(owner.scope);
          if (after.size > limit) throw new WriteRefused([`${after.size} topics, over the limit of ${limit}`]);
          if (key.scope === 'person' && after.size > 0 && !after.has(PROFILE_TOPIC)) {
            throw new WriteRefused(['a person\'s notes must include the "profile" topic']);
          }

          for (const draft of valid) {
            const existing = this.anyNote(key.scope, key.ownerId, draft.topic);
            if (existing?.active && existing.title === draft.title && existing.content === draft.content) {
              unchanged.push(draft.topic);
              continue;
            }
            written.push(
              this.putVersion(
                key.scope,
                key.ownerId,
                draft.topic,
                existing,
                version({ title: draft.title, content: draft.content, aliases: [], members: null, active: true }),
              ),
            );
          }
          for (const topic of removeTopics) {
            const existing = current.get(topic);
            if (!existing) continue;
            removed.push(
              this.putVersion(
                key.scope,
                key.ownerId,
                topic,
                existing,
                version({
                  title: existing.title,
                  content: existing.content,
                  aliases: [],
                  members: null,
                  active: false,
                }),
              ),
            );
          }
        }

        if (circles.length > 0 || removeCircles.length > 0) {
          const outcome = this.writeCircleDrafts(circles, removeCircles, plan, allowedIds, version);
          written.push(...outcome.written);
          removed.push(...outcome.removed);
          unchanged.push(...outcome.unchanged);
        }
        return { ok: true as const, written, removed, unchanged };
      });
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, errors: error.errors };
      throw error;
    }
  }

  /** The circle half of write(), inside its transaction; throws WriteRefused with every problem found. */
  private writeCircleDrafts(
    circles: CircleDraft[],
    removeCircles: string[],
    plan: { circlesMustInclude?: string },
    allowedIds: string[],
    version: (fields: Omit<VersionInput, 'at' | 'updatedBy' | 'reason'>, why?: string | null) => VersionInput,
  ): { written: Note[]; removed: Note[]; unchanged: string[] } {
    const errors: string[] = [];
    const known = new Set([...allowedIds.map((id) => canonicalUserId(id)), ...config.server.linkedAccounts.values()]);
    const isKnown = (id: string) =>
      known.has(id) || this.memory.getIdentityById(id) !== undefined || config.server.linkedAccounts.has(id);
    const mustInclude = plan.circlesMustInclude ? canonicalUserId(plan.circlesMustInclude) : undefined;
    const includesOwner = (members: CircleMember[]) => !mustInclude || members.some((m) => m.memberId === mustInclude);

    const written: Note[] = [];
    const removed: Note[] = [];
    const unchanged: string[] = [];
    const touched = new Set<string>();

    const deactivate = (slug: string, label: string, why?: string | null) => {
      const existing = this.anyNote('circle', '', slug);
      if (!existing?.active) {
        errors.push(`${label} "${slug}" is not an active circle`);
        return;
      }
      if (!includesOwner(existing.members)) {
        errors.push(`circle "${slug}": a person's notes only change circles they are part of`);
        return;
      }
      for (const m of existing.members) touched.add(m.memberId);
      removed.push(
        this.putVersion(
          'circle',
          '',
          slug,
          existing,
          version(
            {
              title: existing.title,
              content: existing.content,
              aliases: existing.aliases,
              members: existing.members,
              active: false,
            },
            why,
          ),
        ),
      );
    };

    for (const draft of circles) {
      const label = `circle "${draft.slug}"`;
      const members: CircleMember[] = [];
      for (const m of draft.members) {
        const main = canonicalUserId(m.id);
        if (members.some((x) => x.memberId === main)) {
          errors.push(`${label}: member ${m.id} is listed twice (linked accounts are one member)`);
          continue;
        }
        if (!isKnown(main)) {
          errors.push(`${label}: member ${m.id} is nobody the bot knows`);
          continue;
        }
        members.push({ memberId: main, since: m.since ?? null, until: m.until ?? null, role: m.role ?? null });
      }
      members.sort(byMembership);
      const existing = this.anyNote('circle', '', draft.slug);
      if (!includesOwner(members) || (existing?.active && !includesOwner(existing.members))) {
        errors.push(`${label}: a person's notes only change circles they are part of`);
        continue;
      }
      for (const merged of draft.merged_from) deactivate(merged, `${label}: merged_from`, `merged into ${draft.slug}`);
      for (const m of [...members, ...(existing?.members ?? [])]) touched.add(m.memberId);
      if (
        existing?.active &&
        existing.title === draft.title &&
        existing.content === draft.content &&
        JSON.stringify(existing.aliases) === JSON.stringify(draft.aliases) &&
        sameMembers(existing.members, members)
      ) {
        unchanged.push(`circle:${draft.slug}`);
        continue;
      }
      written.push(
        this.putVersion(
          'circle',
          '',
          draft.slug,
          existing,
          version({ title: draft.title, content: draft.content, aliases: draft.aliases, members, active: true }),
        ),
      );
    }
    for (const slug of removeCircles) deactivate(slug, 'removed circle');

    errors.push(...this.circleLimitProblems(touched));
    if (errors.length > 0) throw new WriteRefused(errors);
    return { written, removed, unchanged };
  }

  /** Circle limits after a write: the active total, and each touched member's current circles. */
  private circleLimitProblems(members: Iterable<string>): string[] {
    const problems: string[] = [];
    const total = (
      this.stmt("SELECT COUNT(*) AS n FROM notes WHERE scope = 'circle' AND active = 1").get() as { n: number }
    ).n;
    if (total > NOTE_LIMITS.maxCircles) problems.push(`${total} circles, over the limit of ${NOTE_LIMITS.maxCircles}`);
    const perMember = this.stmt(
      `SELECT COUNT(*) AS n FROM note_members m JOIN notes n ON n.id = m.note_id
       WHERE m.member_id = ? AND m.until IS NULL AND n.active = 1 AND n.scope = 'circle'`,
    );
    for (const member of members) {
      const n = (perMember.get(member) as { n: number }).n;
      if (n > NOTE_LIMITS.maxCirclesPerMember) {
        problems.push(
          `member ${member} would be in ${n} circles, over the limit of ${NOTE_LIMITS.maxCirclesPerMember}`,
        );
      }
    }
    return problems;
  }

  /**
   * Restores the version before a note's current one as a new version (updated_by 'undo'): its title,
   * content, aliases, a circle's membership, and whether it was active. Undoing twice restores what the
   * first undo replaced. Refused for a note with no earlier version, and when bringing a removed topic or
   * circle back would pass a limit.
   */
  undo(noteId: number, opts: { reason?: string } = {}): UndoResult {
    const note = this.getNoteById(noteId);
    if (!note) return { ok: false, error: 'no such note' };
    const previous = this.getVersion(noteId, note.version - 1);
    if (!previous) return { ok: false, error: 'there is no earlier version to go back to' };

    const owner = ownerOf(note);
    if (owner && previous.active && !note.active && this.listNotes(owner).length >= maxTopicsFor(owner.scope)) {
      return { ok: false, error: 'bringing that topic back would pass the topic limit' };
    }
    const scope = note.scope;
    const ownerId = note.ownerId ?? '';
    try {
      const restored = this.runInTransaction(() => {
        const result = this.putVersion(scope, ownerId, note.topic, note, {
          title: previous.title,
          content: previous.content,
          aliases: previous.aliases,
          members: scope === 'circle' ? (previous.members ?? note.members) : null,
          active: previous.active,
          at: toSqliteUtc(this.now()),
          updatedBy: 'undo',
          reason: (opts.reason ?? `undo of v${note.version} (back to v${previous.version})`).slice(0, MAX_REASON_CHARS),
        });
        if (scope === 'circle') {
          const problems = this.circleLimitProblems(
            new Set([...result.members, ...note.members].map((m) => m.memberId)),
          );
          if (problems.length > 0) throw new WriteRefused(problems);
        }
        return result;
      });
      return { ok: true, note: restored };
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, error: error.errors.join('; ') };
      throw error;
    }
  }

  /**
   * Trims each note's version history to its newest `keep` versions (the current one included; never
   * fewer than 2, so undo always has the version before), except the bootstrap's and the owner's edits,
   * which are always kept. Returns how many versions were removed. The nightly dream writes a new profile
   * version for most active people every night, so the history would otherwise grow without end.
   */
  pruneVersions(opts: { keep?: number } = {}): number {
    const keep = Math.max(2, Math.floor(opts.keep ?? NOTE_VERSIONS_KEPT));
    const kept = KEPT_WRITERS.map((w) => `'${w}'`).join(', ');
    return this.stmt(
      `DELETE FROM note_versions
       WHERE updated_by NOT IN (${kept})
         AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY version DESC) AS newest
             FROM note_versions
           ) WHERE newest > ?
         )`,
    ).run(keep).changes;
  }

  /** Rebuilds the notes FTS index from the active notes (belt and braces; the triggers keep it right). */
  rebuildFtsIndex(): number {
    return this.runInTransaction(() => {
      this.stmt('DELETE FROM notes_fts').run();
      return this.stmt(
        'INSERT INTO notes_fts(rowid, title, content, aliases) SELECT id, title, content, aliases FROM notes WHERE active = 1',
      ).run().changes;
    });
  }

  private anyNote(scope: NoteScope, ownerId: string, topic: string): Note | undefined {
    const row = this.stmt('SELECT * FROM notes WHERE scope = ? AND owner_id = ? AND topic = ?').get(
      scope,
      ownerId,
      topic,
    ) as NoteRow | undefined;
    return row ? this.toNote(row) : undefined;
  }

  /**
   * Writes the next version of a note (creating it at v1), records it in note_versions, and replaces a
   * circle's membership. In a transaction.
   */
  private putVersion(
    scope: NoteScope,
    ownerId: string,
    topic: string,
    existing: Note | undefined,
    next: VersionInput,
  ): Note {
    const aliases = JSON.stringify(next.aliases);
    let id: number;
    let version: number;
    if (existing) {
      id = existing.id;
      version = existing.version + 1;
      this.stmt(
        `UPDATE notes SET title = ?, content = ?, aliases = ?, version = ?, updated_at = ?, updated_by = ?, active = ?
         WHERE id = ?`,
      ).run(next.title, next.content, aliases, version, next.at, next.updatedBy, next.active ? 1 : 0, id);
    } else {
      version = 1;
      id = Number(
        this.stmt(
          `INSERT INTO notes (scope, owner_id, topic, title, content, aliases, version, updated_at, updated_by, active)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(scope, ownerId, topic, next.title, next.content, aliases, next.at, next.updatedBy, next.active ? 1 : 0)
          .lastInsertRowid,
      );
    }
    if (next.members) {
      this.stmt('DELETE FROM note_members WHERE note_id = ?').run(id);
      const insert = this.stmt(
        'INSERT INTO note_members (note_id, member_id, since, until, role) VALUES (?, ?, ?, ?, ?)',
      );
      for (const m of next.members) insert.run(id, m.memberId, m.since, m.until, m.role);
    }
    this.stmt(
      `INSERT INTO note_versions (note_id, version, title, content, aliases, members, active, updated_at, updated_by, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      version,
      next.title,
      next.content,
      aliases,
      next.members ? JSON.stringify([...next.members].sort(byMembership)) : null,
      next.active ? 1 : 0,
      next.at,
      next.updatedBy,
      next.reason,
    );
    const note = this.getNoteById(id);
    if (!note) throw new Error(`note #${id} vanished while it was written`);
    return note;
  }

  private toNote(row: NoteRow): Note {
    const members =
      row.scope === 'circle'
        ? (this.stmt('SELECT * FROM note_members WHERE note_id = ?').all(row.id) as MemberRow[])
            .map(toMember)
            .sort(byMembership)
        : [];
    return {
      id: row.id,
      scope: row.scope,
      ownerId: row.scope === 'person' ? row.owner_id : null,
      topic: row.topic,
      title: row.title,
      content: row.content,
      aliases: parseJsonArray(row.aliases, isString),
      members,
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      active: row.active === 1,
    };
  }

  // ---- The journal (the memories table) ----

  /** The journal clock's current value: the highest journal_seq of any row (0 for an empty journal). */
  journalHighWater(): number {
    const row = this.stmt('SELECT COALESCE(MAX(journal_seq), 0) AS seq FROM memories').get() as { seq: number };
    return row.seq;
  }

  /**
   * An owner's active journal rows with journal_seq above `afterSeq`, oldest first (by journal_seq).
   * A person's rows are the ones stamped with any of their account ids, the ones that name them among
   * their related members (a relationship or shared event filed under someone else), plus rows filed under
   * one of their names that carry no id (getForPerson's rule: a name never claims a row another member's id
   * is on). Only names nobody else goes by, in any form, claim an id-less row (the startup stamp's rule): a
   * row filed under a name two members share ("Rem", one's IRL name and the other's nickname) is left for
   * the stamp, never read into both people's notes. The group's rows are the ones about the server as a
   * whole. Self-diagnosis rows are never included.
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

    if (owner.scope === 'group') {
      return this.stmt(
        `SELECT * FROM (
           SELECT * FROM memories
           WHERE active = 1 AND journal_seq > ? AND subject_user_id IS NULL
             AND lower(subject) IN (SELECT value FROM json_each(?))
             AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) ${kindFilter}
           ORDER BY journal_seq DESC LIMIT ?
         ) ORDER BY journal_seq ASC`,
      ).all(afterSeq, GROUP_SUBJECTS, limit) as Memory[];
    }
    const ids = JSON.stringify(accountIdsFor(owner.ownerId));
    const names = this.ownNames(owner.ownerId, owner.names ?? this.namesOf(accountIdsFor(owner.ownerId)));
    return this.stmt(
      `SELECT * FROM (
         SELECT * FROM memories
         WHERE active = 1 AND journal_seq > @after
           AND (subject_user_id IN (SELECT value FROM json_each(@ids))
                OR (subject_user_id IS NULL AND subject IN (SELECT value FROM json_each(@names)))
                OR EXISTS (SELECT 1 FROM json_each(memories.related_user_ids) r
                           WHERE r.value IN (SELECT value FROM json_each(@ids))))
           AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) ${kindFilter}
         ORDER BY journal_seq DESC LIMIT @limit
       ) ORDER BY journal_seq ASC`,
    ).all({ after: afterSeq, ids, names: JSON.stringify(names), limit }) as Memory[];
  }

  /** The owner's journal rows the notes don't reflect yet (above their watermark). */
  newJournal(owner: JournalOwner, opts: JournalOptions = {}): Memory[] {
    return this.journalSince(owner, this.getDreamState(owner).journalWatermark, opts);
  }

  /**
   * Corrections about the owner that no dream has folded in yet: shown next to the notes until then.
   * Only rows ABOUT them (subject), not corrections of someone else that merely relate to them.
   */
  openCorrections(owner: JournalOwner, limit = 20): Memory[] {
    const rows = this.newJournal(owner, { kinds: 'corrections' });
    const mine =
      owner.scope === 'group'
        ? rows
        : rows.filter((r) => !r.subject_user_id || canonicalUserId(r.subject_user_id) === owner.ownerId);
    return mine.slice(Math.max(0, mine.length - limit));
  }

  /**
   * Owners with journal rows above their watermark, most recently active first: people (by the id their
   * rows are stamped with, a linked side account's counting for its main, and by the related members of
   * relationship rows; name-only rows get an id from the startup stamp) and the group. `limit` caps the
   * people.
   *
   * Only real people: a member the bot knows (an identities row on any of their accounts, or a
   * LINKED_ACCOUNTS id), or a Discord-shaped id that a writer other than the old learner vouched for
   * (remember_fact, "Remember this", a correction, a capture's related members). The startup stamp's
   * junk ids (MemoryStore.stampSubjectUserIds: "456" copied from the old learner's prompt, a garbled
   * snowflake on a learner row) left in place when their name is ambiguous or unknown never become a
   * phantom person with a paid dream and notes of their own: their rows wait in the journal for the stamp.
   */
  pendingDreams(opts: { limit?: number } = {}): { people: PendingDream[]; group?: PendingDream } {
    const rows = this.stmt(
      `SELECT subject_user_id AS uid, related_user_ids AS related, journal_seq AS seq, source FROM memories
       WHERE active = 1 AND (subject_user_id IS NOT NULL OR related_user_ids IS NOT NULL)
         AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN})`,
    ).all() as { uid: string | null; related: string | null; seq: number; source: string | null }[];

    const watermarks = new Map<string, number>();
    const byOwner = new Map<string, { newRows: number; latestSeq: number }>();
    // Ids some row vouches for: stamped by a writer other than the old learner, or a related member.
    const vouched = new Set<string>();
    const watermarkOf = (id: string) => {
      let mark = watermarks.get(id);
      if (mark === undefined) {
        mark = this.getDreamState({ scope: 'person', ownerId: id }).journalWatermark;
        watermarks.set(id, mark);
      }
      return mark;
    };
    for (const row of rows) {
      const related = parseJsonArray(row.related, isString).map((id) => canonicalUserId(id));
      const uid = row.uid ? canonicalUserId(row.uid) : undefined;
      if (uid && !LEARNER_SOURCE_SET.has(row.source ?? '')) vouched.add(uid);
      for (const id of related) vouched.add(id);
      const owners = new Set([...(uid ? [uid] : []), ...related]);
      for (const main of owners) {
        if (row.seq <= watermarkOf(main)) continue;
        const entry = byOwner.get(main) ?? { newRows: 0, latestSeq: 0 };
        entry.newRows++;
        entry.latestSeq = Math.max(entry.latestSeq, row.seq);
        byOwner.set(main, entry);
      }
    }
    const isRealPerson = (main: string) => this.isKnownMember(main) || (DISCORD_ID.test(main) && vouched.has(main));
    const people: PendingDream[] = [...byOwner.entries()]
      .filter(([ownerId]) => isRealPerson(ownerId))
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

  /** A member the bot knows: an identities row on any of their accounts, or a LINKED_ACCOUNTS id. */
  private isKnownMember(mainId: string): boolean {
    const links = config.server.linkedAccounts;
    return (
      links.has(mainId) ||
      [...links.values()].includes(mainId) ||
      accountIdsFor(mainId).some((id) => this.memory.getIdentityById(id) !== undefined)
    );
  }

  /** Of these names, the ones no other member goes by in any form (active identities, like the stamp). */
  private ownNames(ownerId: string, names: string[]): string[] {
    if (names.length === 0) return names;
    const main = canonicalUserId(ownerId);
    const identities = this.memory.getAllIdentities().filter((i) => i.active !== 0);
    return names.filter((name) => everyoneGoingBy(identities, name).every((id) => id === main));
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
