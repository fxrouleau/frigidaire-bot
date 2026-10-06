// Memory v2 notes (docs/memory.md): per-person markdown notes (a `profile` plus topic notes), the group's
// notes, circles (a note shared by a SET of members, with dated membership) and occasions (a note about
// one notable thing specific members do together at a date: a trip, an outing), derived from the journal
// (the `memories` table) by the nightly dream, owner edits and the bootstrap. The journal stays the source
// of truth; notes can always be regenerated from it.
//
// Tables live in memory.db next to the journal, on the MemoryStore's handle:
//   notes          one row per (scope, owner, topic): the current version. owner_id is the person's main
//                  id, '' for the group, circles and occasions (their topic is a slug unique within their
//                  scope). Circles and occasions carry `aliases` (JSON array of other names the group uses
//                  for them) and `status` (a circle: 'archived' or NULL; an occasion: its OccasionStatus);
//                  occasions also `starts_on`/`ends_on` (partial dates) and `place`.
//   note_members   a circle's members or an occasion's participants, dated: (note_id, member_id, since,
//                  until, role). until NULL = current.
//   note_versions  every version ever written, the current one included, with a circle's or occasion's
//                  membership snapshot and its `details` (status, dates, place) as JSON (undo restores the
//                  previous version, membership and details included).
//   notes_fts      a plain (not external-content) FTS5 table over active notes (title, content, aliases),
//                  kept by triggers on `notes` alone, so it is correct by construction: a DELETE of a
//                  missing row is harmless here, unlike the external-content 'delete' command that once
//                  corrupted memories_fts.
//   dream_state    per person and for the group: the journal watermark (the highest journal_seq folded
//                  into the notes), when the last dream ran and its last error. Circles have none: the
//                  person and group dreams maintain them.
//
// Every write goes through writeNotes()/writeCircles()/applyNotesOutput()/archiveNote()/undo(): validated
// first (schema.ts), then all-or-nothing in one transaction. Nothing is ever hard-deleted: removing a topic,
// a circle or an occasion deactivates it and records a version; archiving one keeps it (readable,
// searchable) as a short trace.
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
  relatedUserIdsOf,
  SELF_DIAGNOSIS_CATEGORIES,
} from '../memoryStore';
import { STOP_WORDS } from '../wordOverlap';
import { circlesNamedIn } from './context';
import {
  type ActivityMonth,
  addDays,
  CIRCLE_DECAY,
  circlePresence,
  defaultOccasionStatus,
  easternDayOfTimestamp,
  easternToday,
  isArchived,
  OCCASION_LIFECYCLE,
  occasionEndDay,
  partialDateStart,
} from './lifecycle';
import {
  ARCHIVED_STATUS,
  type CircleDraft,
  type CircleMember,
  type CircleMemberDraft,
  contentProblems,
  endsBeforeStart,
  isSharedScope,
  maxCharsFor,
  maxTopicsFor,
  NOTE_LIMITS,
  type NoteDraft,
  type NoteOwner,
  type NoteScope,
  type NoteStatus,
  type NotesOutput,
  type NoteUpdatedBy,
  normalizeTopic,
  OCCASION_STATUSES,
  type OccasionDraft,
  PROFILE_TOPIC,
  type SharedScope,
  validateCircleDraft,
  validateNoteDraft,
  validateOccasionDraft,
} from './schema';

export { toSqliteUtc };

/** The current version of one note (a person's topic, a group topic, a circle or an occasion). */
export type Note = {
  id: number;
  scope: NoteScope;
  /** The person's main account id; null for the group, circles and occasions. */
  ownerId: string | null;
  /** The topic slug; a circle's or occasion's unique slug. */
  topic: string;
  title: string;
  /** Markdown. */
  content: string;
  /** Other names a circle or occasion goes by ([] for person and group notes). */
  aliases: string[];
  /**
   * A circle's members or an occasion's participants, current and former, by main id ([] for person and
   * group notes).
   */
  members: CircleMember[];
  version: number;
  /** SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS"), like every memory.db timestamp. */
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  active: boolean;
  /**
   * An occasion's status as last written (OccasionStatus); 'archived' for an archived circle (null while it
   * is live); null for person and group notes. lifecycle.ts occasionPhase() says where an occasion is today.
   */
  status: NoteStatus | null;
  /** An occasion's dates (partial: YYYY, YYYY-MM, YYYY-MM-DD; endsOn null for a one-day thing); null otherwise. */
  startsOn: string | null;
  endsOn: string | null;
  /** Where an occasion takes place; null otherwise. */
  place: string | null;
  /** The slug of the circle an occasion belongs to (a tradition's outing); null otherwise. */
  circle: string | null;
};

/** A circle's or occasion's details as one version records them (undo restores them). */
export type NoteDetails = Pick<Note, 'status' | 'startsOn' | 'endsOn' | 'place' | 'circle'>;

/** One stored version of a note (the current one included). */
export type NoteVersion = {
  noteId: number;
  version: number;
  title: string;
  content: string;
  aliases: string[];
  /** A circle's membership (an occasion's participants) as of this version; null for person and group notes. */
  members: CircleMember[] | null;
  /**
   * A circle's or occasion's status, dates and place as of this version; null for person and group notes,
   * and for circle versions written before archiving existed (a live circle).
   */
  details: NoteDetails | null;
  /** False for the version that removed the topic or circle. */
  active: boolean;
  updatedAt: string;
  updatedBy: NoteUpdatedBy;
  /** Why: the dream's change summary, the owner's edit instruction, "undo of v3", "merged into mtg", … */
  reason: string | null;
};

/** A member's place in a circle. */
export type CircleMembership = { circle: Note; membership: CircleMember };

/** A member's place in an occasion. */
export type OccasionParticipation = { occasion: Note; membership: CircleMember };

/** One version written to a person's note, a circle or an occasion (see NotesStore.changesSince). */
export type NoteChange = {
  noteId: number;
  scope: 'person' | 'circle' | 'occasion';
  /** The person's main id; null for a circle or an occasion. */
  ownerId: string | null;
  /** The topic, or the circle's or occasion's slug. */
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
   * Circle slugs to archive in the same transaction: kept as they are (or as `circles` writes them), with
   * status 'archived' and every current membership ended at the archive's month. A circle written in
   * `circles` without being listed here is live again (revived).
   */
  archiveCircles?: string[];
  /**
   * Activity to record for circles this write creates or rewrites (slug → `YYYY-MM` → weight, raised like a
   * seed, never reviving anything), before the limits are checked: a notes tree's activity.json, so a
   * member's old circles already count as fading at the import (lifecycle.ts CIRCLE_DECAY).
   */
  circleActivity?: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /** Occasions to create or update in the same transaction (validated like validateOccasionDraft). */
  occasions?: unknown[];
  /** Occasion slugs to remove (deactivate) in the same transaction. */
  removeOccasions?: string[];
  /**
   * Only circles and occasions this member (main id) is or was in may be written, merged, archived or
   * removed, and a written one must keep them listed: a person's dream or edit never rewrites shared notes
   * they aren't part of. writeNotes() sets it to the person for a person's write unless `anyCircle` is set.
   */
  circlesMustInclude?: string;
  /**
   * Lets a person's write touch any circle or occasion (owner edits of one go through writeCircles /
   * writeOccasions instead).
   */
  anyCircle?: boolean;
};

export type WriteNotesResult =
  | {
      ok: true;
      /** Notes, circles and occasions created or changed by this write (their new current version). */
      written: Note[];
      /** What this write deactivated (removed, or merged into another circle). */
      removed: Note[];
      /**
       * What matched the current version exactly (no new version): topics, circles as `circle:<slug>`,
       * occasions as `occasion:<slug>`.
       */
      unchanged: string[];
    }
  | { ok: false; errors: string[] };

export type UndoResult =
  | {
      ok: true;
      note: Note;
      /**
       * Other notes the undone version changed in the same write and that undo reverted with it: the
       * circles a merge deactivated, back to their version before the merge (or merged away again when
       * undoing that undo). Empty for a plain note.
       */
      alsoRestored: Note[];
    }
  | { ok: false; error: string };

/** Another note's version written by the same write as a version (a merge's merged-away circle). */
type LinkedVersion = { noteId: number; version: number };

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
  /** What a dream reads: leaves out DREAM_EXCLUDED_CATEGORIES. */
  dream?: boolean;
};

/**
 * Journal categories the dream never reads (and that never make someone's dream pending): image rows say
 * someone shared a picture or a meme. They expire within a day, and the notes are permanent: folded in,
 * they turned a day's memes into lasting "facts" and filled full profiles past their limit.
 */
export const DREAM_EXCLUDED_CATEGORIES = ['image'] as const;
const DREAM_EXCLUDED_NOT_IN = DREAM_EXCLUDED_CATEGORIES.map((c) => `'${c}'`).join(', ');

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
  starts_on: string | null;
  ends_on: string | null;
  place: string | null;
  status: string | null;
  circle: string | null;
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
  linked: string | null;
  details: string | null;
};

/**
 * The notes table's columns (the scope CHECK names every scope). A database created before occasions has a
 * CHECK without 'occasion' and none of the last four columns: init() rebuilds the table in place
 * (migrateNotesTable), since SQLite can't alter a CHECK.
 */
const NOTES_TABLE_SQL = `(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL CHECK (scope IN ('person', 'group', 'circle', 'occasion')),
  owner_id    TEXT    NOT NULL DEFAULT '',
  topic       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  aliases     TEXT    NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  starts_on   TEXT,
  ends_on     TEXT,
  place       TEXT,
  status      TEXT,
  circle      TEXT,
  UNIQUE (scope, owner_id, topic),
  CHECK ((scope = 'person') = (owner_id != ''))
)`;
const NOTES_COLUMNS = [
  'id',
  'scope',
  'owner_id',
  'topic',
  'title',
  'content',
  'aliases',
  'version',
  'updated_at',
  'updated_by',
  'active',
  'starts_on',
  'ends_on',
  'place',
  'status',
  'circle',
];
const NOTE_STATUSES: ReadonlySet<string> = new Set(OCCASION_STATUSES);
/** SQL: a circle or occasion that isn't archived. */
const LIVE = `(n.status IS NULL OR n.status != '${ARCHIVED_STATUS}')`;
/** The journal rows the occasion pass reads at most. */
const MAX_OCCASION_JOURNAL_ROWS = 150;
/** A month of activity: `YYYY-MM`. */
const ACTIVITY_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
/** How much further around an occasion a row that names it still counts (days before / after). */
const OCCASION_NAMED_WINDOW = { before: 60, after: 30 } as const;

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
const isLinkedVersion = (v: unknown): v is LinkedVersion =>
  !!v &&
  typeof v === 'object' &&
  Number.isInteger((v as LinkedVersion).noteId) &&
  Number.isInteger((v as LinkedVersion).version);
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

/**
 * A circle's members with every current membership ended at `until` (a partial date: the archive's month),
 * or at its own `since` when that is later: an archived circle has no current member. Former members keep
 * their dates.
 */
export function endCurrentMemberships(members: CircleMember[], until: string): CircleMember[] {
  return members
    .map((m) => (m.until !== null ? m : { ...m, until: m.since && endsBeforeStart(m.since, until) ? m.since : until }))
    .sort(byMembership);
}

function sameMembers(a: CircleMember[], b: CircleMember[]): boolean {
  const key = (m: CircleMember[]) => JSON.stringify([...m].sort(byMembership));
  return key(a) === key(b);
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const statusOrNull = (v: unknown): NoteStatus | null =>
  typeof v === 'string' && NOTE_STATUSES.has(v) ? (v as NoteStatus) : null;

function parseDetails(raw: string | null): NoteDetails | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fields = parsed as Record<string, unknown>;
    return {
      status: statusOrNull(fields.status),
      startsOn: stringOrNull(fields.startsOn),
      endsOn: stringOrNull(fields.endsOn),
      place: stringOrNull(fields.place),
      circle: stringOrNull(fields.circle),
    };
  } catch {
    return null;
  }
}

/** A circle's or occasion's details; null for person and group notes. */
export function detailsOf(
  note: Pick<Note, 'scope' | 'status' | 'startsOn' | 'endsOn' | 'place' | 'circle'>,
): NoteDetails | null {
  if (!isSharedScope(note.scope)) return null;
  return { status: note.status, startsOn: note.startsOn, endsOn: note.endsOn, place: note.place, circle: note.circle };
}

const LIVE_CIRCLE: NoteDetails = { status: null, startsOn: null, endsOn: null, place: null, circle: null };

function sameDetails(a: NoteDetails | null, b: NoteDetails | null): boolean {
  return JSON.stringify(a ?? LIVE_CIRCLE) === JSON.stringify(b ?? LIVE_CIRCLE);
}

/**
 * The details an undo puts back from `version`: what it recorded, a live circle for a circle version
 * written before archiving existed, the note's own for anything else that recorded none; null for person
 * and group notes.
 */
function restoredDetails(note: Note, version: NoteVersion): NoteDetails | null {
  if (!isSharedScope(note.scope)) return null;
  if (version.details) return version.details;
  return note.scope === 'circle' ? LIVE_CIRCLE : detailsOf(note);
}

function toVersion(row: VersionRow): NoteVersion {
  return {
    noteId: row.note_id,
    version: row.version,
    title: row.title,
    content: row.content,
    aliases: parseJsonArray(row.aliases, isString),
    members: row.members === null ? null : parseJsonArray(row.members, isMember),
    details: parseDetails(row.details),
    active: row.active === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    reason: row.reason,
  };
}

/** The owner a person or group note belongs to; undefined for a circle or an occasion (see Note.members). */
export function ownerOf(note: Pick<Note, 'scope' | 'ownerId'>): NoteOwner | undefined {
  if (isSharedScope(note.scope)) return undefined;
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

const SCOPE_ORDER: Record<NoteScope, number> = { person: 0, group: 1, circle: 2, occasion: 3 };

/** A write refused inside the transaction (it rolls back); turned into WriteNotesResult errors. */
class WriteRefused extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}

/** The counts the shared notes' limits apply to (NotesStore.limitSnapshot). */
type LimitSnapshot = { circles: number; occasions: number; perMember: Map<string, number> };

type ActivityRow = { month: string; weight: number; ambient: number; revival: number };

function toActivityMonth(row: ActivityRow): ActivityMonth {
  return {
    month: row.month,
    weight: row.weight,
    ...(row.ambient > 0 ? { ambient: row.ambient } : {}),
    ...(row.revival ? { revival: true } : {}),
  };
}

type VersionInput = {
  title: string;
  content: string;
  aliases: string[];
  /** A circle's or occasion's full membership (replaces the stored one); null for person and group notes. */
  members: CircleMember[] | null;
  /** A circle's or occasion's status, dates and place; null for person and group notes. */
  details: NoteDetails | null;
  active: boolean;
  at: string;
  updatedBy: NoteUpdatedBy;
  reason: string | null;
  /** Other notes' versions this write made along with this one, reverted with it by undo (a merge's). */
  linked?: LinkedVersion[];
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS notes ${NOTES_TABLE_SQL};`);
    const upgraded = this.migrateNotesTable();
    const noteColumns = this.db.prepare('PRAGMA table_info(notes)').all() as { name: string }[];
    if (!noteColumns.some((c) => c.name === 'circle')) this.db.exec('ALTER TABLE notes ADD COLUMN circle TEXT');
    // A circle's activity by month (lifecycle.ts CIRCLE_DECAY): `weight`, the journal rows its dreams folded
    // that name it and involve two or more of its members, its linked occasions, a seed from the archive;
    // `ambient`, rows about two of its members that named no circle (present circles only, capped: never a
    // real month); `revival`, the month it came back from the archive.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS note_activity (
        note_id  INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        month    TEXT    NOT NULL,
        weight   INTEGER NOT NULL DEFAULT 0,
        ambient  INTEGER NOT NULL DEFAULT 0,
        revival  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (note_id, month)
      ) WITHOUT ROWID;
    `);
    const activityColumns = this.db.prepare('PRAGMA table_info(note_activity)').all() as { name: string }[];
    if (!activityColumns.some((c) => c.name === 'ambient')) {
      this.db.exec('ALTER TABLE note_activity ADD COLUMN ambient INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec(`
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
        linked      TEXT,
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
    // Added after note_versions first shipped: a database created before them gets the columns here.
    const versionColumns = this.db.prepare('PRAGMA table_info(note_versions)').all() as { name: string }[];
    if (!versionColumns.some((c) => c.name === 'linked')) {
      this.db.exec('ALTER TABLE note_versions ADD COLUMN linked TEXT');
    }
    if (!versionColumns.some((c) => c.name === 'details')) {
      this.db.exec('ALTER TABLE note_versions ADD COLUMN details TEXT');
    }

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
    // After the upgrade, the index is rebuilt from the notes (it is keyed by their ids, which the rebuild
    // kept; this only makes sure, in milliseconds).
    if (upgraded) this.rebuildFtsIndex();
  }

  /**
   * Upgrades a notes table created before occasions (its scope CHECK has no 'occasion', and it lacks the
   * starts_on/ends_on/place/status/circle columns) in place: SQLite can't alter a CHECK, so the table is
   * rebuilt (the documented way: foreign keys off, copy into a new table, drop the old one, rename, check the
   * foreign keys, all in one transaction). Every row keeps its id, so note_members, note_versions, notes_fts
   * and the viewer's custom ids stay valid; the FTS triggers go with the old table and init() recreates
   * them. Runs once (true when it did); refuses to run inside a transaction (foreign keys can't be switched
   * off there, and dropping the table with them on would cascade into note_members and note_versions). The
   * transaction is IMMEDIATE: another process writing to memory.db makes it wait (the busy timeout), and the
   * table is checked again under the lock (that process may have upgraded it meanwhile).
   */
  private migrateNotesTable(): boolean {
    const needsUpgrade = () => {
      const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get() as
        | { sql: string }
        | undefined;
      return table !== undefined && !table.sql.includes("'occasion'");
    };
    if (!needsUpgrade()) return false;
    if (this.db.inTransaction) {
      throw new Error('notes: the notes table needs its occasions upgrade, which cannot run inside a transaction');
    }
    const foreignKeys = this.db.pragma('foreign_keys', { simple: true }) === 1;
    if (foreignKeys) this.db.pragma('foreign_keys = OFF');
    let upgraded = false;
    try {
      if (this.db.pragma('foreign_keys', { simple: true }) !== 0) {
        throw new Error('notes: could not switch foreign keys off for the occasions upgrade');
      }
      this.db
        .transaction(() => {
          if (!needsUpgrade()) return;
          upgraded = true;
          const existing = new Set(
            (this.db.prepare('PRAGMA table_info(notes)').all() as { name: string }[]).map((c) => c.name),
          );
          const columns = NOTES_COLUMNS.filter((c) => existing.has(c)).join(', ');
          const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notes'").get() as
            | { seq: number }
            | undefined;
          this.db.exec(`
          DROP TABLE IF EXISTS notes_upgrade;
          CREATE TABLE notes_upgrade ${NOTES_TABLE_SQL};
          INSERT INTO notes_upgrade (${columns}) SELECT ${columns} FROM notes;
          DROP TABLE notes;
          ALTER TABLE notes_upgrade RENAME TO notes;
        `);
          if (sequence) {
            this.db
              .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'notes'")
              .run(Math.floor(sequence.seq));
          }
          // Only the tables that point at notes: whatever else the database holds is not this upgrade's.
          for (const child of ['note_members', 'note_versions', 'note_activity']) {
            const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(child);
            const broken = exists ? (this.db.pragma(`foreign_key_check(${child})`) as unknown[]) : [];
            if (broken.length > 0) {
              throw new Error(`notes: the occasions upgrade broke ${broken.length} foreign key(s) in ${child}`);
            }
          }
        })
        .immediate();
    } finally {
      if (foreignKeys) this.db.pragma('foreign_keys = ON');
    }
    if (upgraded) logger.info('notes: upgraded the notes table in place for occasions and archived circles');
    return upgraded;
  }

  // ---- Reading notes ----

  /** Today's Eastern calendar day on the store's clock (YYYY-MM-DD): what occasion phases are derived against. */
  today(): string {
    return easternToday(this.now());
  }

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
   * Active circles by title, archived ones left out unless `includeArchived` (they are only a historical
   * trace: out of chat turns, limits and the dreams' full inputs). With `memberId` (any account; its main
   * id is used), only the circles they are currently in, or ever were in with `includeFormer`.
   */
  listCircles(opts: { memberId?: string; includeFormer?: boolean; includeArchived?: boolean } = {}): Note[] {
    return this.listShared('circle', opts).sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * A member's circles (any account; main id used) with their place in each: current ones first, by title
   * (archived ones only with `includeArchived`, after the rest).
   */
  circlesOf(memberId: string, opts: { includeFormer?: boolean; includeArchived?: boolean } = {}): CircleMembership[] {
    const main = canonicalUserId(memberId);
    return this.listCircles({ memberId: main, ...opts })
      .map((circle) => ({ circle, membership: circle.members.find((m) => m.memberId === main) }))
      .filter((c): c is CircleMembership => c.membership !== undefined)
      .sort((a, b) => {
        if (isArchived(a.circle) !== isArchived(b.circle)) return isArchived(a.circle) ? 1 : -1;
        if ((a.membership.until === null) !== (b.membership.until === null))
          return a.membership.until === null ? -1 : 1;
        return a.circle.title.localeCompare(b.circle.title);
      });
  }

  /** An active occasion by its slug (archived ones included: they stay readable). */
  getOccasion(slug: string): Note | undefined {
    const topic = normalizeTopic(slug);
    if (!topic) return undefined;
    const row = this.stmt(
      "SELECT * FROM notes WHERE scope = 'occasion' AND owner_id = '' AND topic = ? AND active = 1",
    ).get(topic) as NoteRow | undefined;
    return row ? this.toNote(row) : undefined;
  }

  /**
   * Active occasions, by start date (then title), archived ones left out unless `includeArchived`. With
   * `participantId` (any account; main id used), only those they are a current participant of, or ever were
   * with `includeFormer` (someone who bailed). lifecycle.ts byOccasionRelevance() sorts them for listings.
   */
  listOccasions(opts: { participantId?: string; includeFormer?: boolean; includeArchived?: boolean } = {}): Note[] {
    const { participantId, ...rest } = opts;
    return this.listShared('occasion', { memberId: participantId, ...rest }).sort(
      (a, b) => (a.startsOn ?? '').localeCompare(b.startsOn ?? '') || a.title.localeCompare(b.title),
    );
  }

  /** A member's occasions (any account; main id used) with their place in each, by start date. */
  occasionsOf(
    memberId: string,
    opts: { includeFormer?: boolean; includeArchived?: boolean } = {},
  ): OccasionParticipation[] {
    const main = canonicalUserId(memberId);
    return this.listOccasions({ participantId: main, ...opts })
      .map((occasion) => ({ occasion, membership: occasion.members.find((m) => m.memberId === main) }))
      .filter((o): o is OccasionParticipation => o.membership !== undefined);
  }

  private listShared(
    scope: SharedScope,
    opts: { memberId?: string; includeFormer?: boolean; includeArchived?: boolean },
  ): Note[] {
    const live = opts.includeArchived ? '1' : LIVE;
    const rows = (
      opts.memberId
        ? this.stmt(
            `SELECT n.* FROM notes n JOIN note_members m ON m.note_id = n.id
             WHERE n.scope = ? AND n.active = 1 AND ${live} AND m.member_id = ? AND (? OR m.until IS NULL)`,
          ).all(scope, canonicalUserId(opts.memberId), opts.includeFormer ? 1 : 0)
        : this.stmt(`SELECT * FROM notes n WHERE n.scope = ? AND n.active = 1 AND ${live}`).all(scope)
    ) as NoteRow[];
    return rows.map((r) => this.toNote(r));
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
   * Versions written to people's notes, circles and occasions after `since` (a SQLite UTC timestamp; null =
   * ever), oldest first, at most the newest `limit`: what changed in the members' notes since then (the
   * group pass reads it; see dreamer.ts).
   */
  changesSince(since: string | null, opts: { limit?: number } = {}): NoteChange[] {
    const limit = Math.max(0, Math.floor(opts.limit ?? 500));
    const rows = this.stmt(
      `SELECT * FROM (
         SELECT v.id AS vid, v.note_id, v.version, v.title, v.updated_at, v.updated_by, v.reason,
                n.scope, n.owner_id, n.topic
         FROM note_versions v JOIN notes n ON n.id = v.note_id
         WHERE n.scope IN ('person', 'circle', 'occasion') AND (@since IS NULL OR v.updated_at > @since)
         ORDER BY v.id DESC LIMIT @limit
       ) ORDER BY vid ASC`,
    ).all({ since, limit }) as {
      note_id: number;
      version: number;
      title: string;
      updated_at: string;
      updated_by: NoteUpdatedBy;
      reason: string | null;
      scope: 'person' | 'circle' | 'occasion';
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
   * `opts.removeCircles` / `opts.archiveCircles` and occasions in `opts.occasions` / `opts.removeOccasions`,
   * as new versions, all or nothing. Every draft is validated (schema.ts: slug, title, size, no Discord
   * markup/HTML/foreign ids); the result must keep the owner within their topic limit, a person with any
   * notes must have a profile, and circles and occasions must stay within their limits (writeCircles(),
   * writeOccasions()). For a person, circles and occasions are limited to theirs
   * (WriteNotesOptions.circlesMustInclude) unless `anyCircle`. A draft identical to the current version
   * creates no version. Returns the errors instead of throwing; nothing is written then.
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
   * exist and are deactivated; at most NOTE_LIMITS.maxCircles live circles (archived ones don't count), and
   * nobody current in more than NOTE_LIMITS.maxCirclesPerMember present ones (fading and archived ones
   * don't count: circleLimitProblems). Membership is
   * replaced by the draft's. A written circle is live (an archived one is revived) unless it is also in
   * `archiveCircles`.
   */
  writeCircles(circles: unknown[], opts: Omit<WriteNotesOptions, 'circles' | 'removeTopics'>): WriteNotesResult {
    return this.write({ drafts: [], ...opts, circles });
  }

  /**
   * Creates or updates occasions (and removes others) as new versions, all or nothing, like writeCircles():
   * the group dream, an owner edit of an occasion, the occasion pass. Each is validated
   * (validateOccasionDraft); participants resolve to main accounts and must be members the bot knows; at
   * most NOTE_LIMITS.maxOccasions occasions that aren't archived. A draft without a status keeps the stored
   * one (a new occasion: 'planned', or 'past' when its dates are behind).
   */
  writeOccasions(occasions: unknown[], opts: Omit<WriteNotesOptions, 'occasions' | 'removeTopics'>): WriteNotesResult {
    return this.write({ drafts: [], ...opts, occasions });
  }

  /**
   * Saves a validated writer output (schema.ts NotesOutput: a dream's, an owner edit's, the bootstrap's,
   * the occasion pass's) for its target: a person or the group (notes, circles and occasions), one circle
   * (an owner edit of a circle: exactly that circle, which it may archive), or one occasion (an owner edit,
   * the occasion pass: exactly that occasion). The version reason defaults to the output's change summary.
   */
  applyNotesOutput(
    target: NoteOwner | { scope: 'circle'; slug: string } | { scope: 'occasion'; slug: string },
    output: NotesOutput,
    opts: Pick<WriteNotesOptions, 'updatedBy' | 'reason' | 'allowedIds' | 'anyCircle'>,
  ): WriteNotesResult {
    const reason = opts.reason ?? (output.change_summary || undefined);
    const writesTopics = output.notes.length > 0 || output.removed_topics.length > 0;
    if (target.scope === 'circle') {
      const slug = normalizeTopic(target.slug);
      if (writesTopics || output.occasions.length > 0 || output.removed_occasions.length > 0) {
        return { ok: false, errors: ['an edit of a circle writes only that circle'] };
      }
      // Exactly that circle: written (and maybe archived with its new text), or only archived as it is.
      const writesIt = output.circles.length === 1 && output.circles[0].slug === slug;
      const archivesIt = output.circles.length === 0 && output.archived_circles.length === 1;
      if (
        !(writesIt || archivesIt) ||
        output.removed_circles.length > 0 ||
        output.archived_circles.some((s) => s !== slug)
      ) {
        return { ok: false, errors: [`an edit of circle "${slug ?? target.slug}" writes exactly that circle`] };
      }
      return this.writeCircles(output.circles, { ...opts, reason, archiveCircles: output.archived_circles });
    }
    if (target.scope === 'occasion') {
      const slug = normalizeTopic(target.slug);
      if (
        writesTopics ||
        output.circles.length > 0 ||
        output.removed_circles.length > 0 ||
        output.archived_circles.length > 0 ||
        output.removed_occasions.length > 0 ||
        output.occasions.length !== 1 ||
        output.occasions[0].slug !== slug
      ) {
        return { ok: false, errors: [`occasion "${slug ?? target.slug}" is written alone, exactly that occasion`] };
      }
      return this.writeOccasions(output.occasions, { ...opts, reason });
    }
    return this.writeNotes(target, output.notes, {
      ...opts,
      reason,
      removeTopics: output.removed_topics,
      circles: output.circles,
      removeCircles: output.removed_circles,
      archiveCircles: output.archived_circles,
      occasions: output.occasions,
      removeOccasions: output.removed_occasions,
    });
  }

  /**
   * Archives a circle or an occasion: one new version with status 'archived' (a circle's current
   * memberships end at the archive's month; an occasion's participants are kept as they are), its content
   * replaced by `content` when given (the short historical trace the lifecycle pass compacts it to,
   * checked like any note: size, no markup, no ids but its members' and `allowedIds`). An archived note stays
   * readable and searchable; it leaves chat turns, the dreams' full inputs and the limits. Refused when the
   * note is gone, isn't a circle or occasion, or changed since `expectVersion` (an owner edit meanwhile).
   * Archiving an archived note with the same content writes nothing (`unchanged`).
   */
  archiveNote(
    noteId: number,
    opts: {
      content?: string;
      updatedBy: NoteUpdatedBy;
      reason?: string;
      expectVersion?: number;
      allowedIds?: Iterable<string>;
    },
  ): WriteNotesResult {
    try {
      return this.runInTransaction(() => {
        const note = this.getNoteById(noteId);
        if (!note?.active || !isSharedScope(note.scope)) {
          throw new WriteRefused(['only an active circle or occasion can be archived']);
        }
        const label = `${note.scope} "${note.topic}"`;
        if (opts.expectVersion !== undefined && note.version !== opts.expectVersion) {
          throw new WriteRefused([`${label} changed meanwhile (v${note.version}, not v${opts.expectVersion})`]);
        }
        let content = note.content;
        if (opts.content !== undefined) {
          const allowed = new Set([...(opts.allowedIds ?? []), ...note.members.map((m) => m.memberId)]);
          const checked = contentProblems(opts.content, label, maxCharsFor(note.scope, note.topic), allowed);
          if (checked.errors.length > 0 || !checked.content) throw new WriteRefused(checked.errors);
          content = checked.content;
        }
        // An archived circle has no current member (an occasion's participants are who took part: kept).
        const members =
          note.scope === 'circle'
            ? endCurrentMemberships(note.members, easternToday(this.now()).slice(0, 7))
            : note.members;
        if (isArchived(note) && content === note.content && sameMembers(members, note.members)) {
          return { ok: true as const, written: [], removed: [], unchanged: [`${note.scope}:${note.topic}`] };
        }
        const archived = this.putVersion(note.scope, '', note.topic, note, {
          title: note.title,
          content,
          aliases: note.aliases,
          members,
          details: { ...(detailsOf(note) ?? LIVE_CIRCLE), status: ARCHIVED_STATUS },
          active: true,
          at: toSqliteUtc(this.now()),
          updatedBy: opts.updatedBy,
          reason: opts.reason ? opts.reason.slice(0, MAX_REASON_CHARS) : null,
        });
        return { ok: true as const, written: [archived], removed: [], unchanged: [] };
      });
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, errors: error.errors };
      throw error;
    }
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
    const archiveCircles: string[] = [];
    for (const raw of plan.archiveCircles ?? []) {
      const slug = normalizeTopic(raw);
      if (!slug) errors.push(`archived circle "${String(raw).slice(0, 40)}" is not a slug`);
      else if (removeCircles.includes(slug)) errors.push(`circle "${slug}" is both removed and archived`);
      else if (circles.some((c) => c.merged_from.includes(slug))) {
        errors.push(`circle "${slug}" is both merged away and archived`);
      } else if (!archiveCircles.includes(slug)) archiveCircles.push(slug);
    }

    const occasions: OccasionDraft[] = [];
    for (const raw of plan.occasions ?? []) {
      const result = validateOccasionDraft(raw, { allowedIds });
      if (!result.ok) errors.push(...result.errors);
      else if (occasions.some((o) => o.slug === result.value.slug))
        errors.push(`occasion "${result.value.slug}" appears twice`);
      else occasions.push(result.value);
    }
    const removeOccasions: string[] = [];
    for (const raw of plan.removeOccasions ?? []) {
      const slug = normalizeTopic(raw);
      if (!slug) errors.push(`removed occasion "${String(raw).slice(0, 40)}" is not a slug`);
      else if (occasions.some((o) => o.slug === slug)) errors.push(`occasion "${slug}" is both written and removed`);
      else if (!removeOccasions.includes(slug)) removeOccasions.push(slug);
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
                version({
                  title: draft.title,
                  content: draft.content,
                  aliases: [],
                  members: null,
                  details: null,
                  active: true,
                }),
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
                  details: null,
                  active: false,
                }),
              ),
            );
          }
        }

        const sharedErrors: string[] = [];
        const writesShared =
          circles.length + removeCircles.length + archiveCircles.length + occasions.length + removeOccasions.length > 0;
        // The limits as they were before this write: a write is refused only for making a count worse.
        const before = writesShared ? this.limitSnapshot() : undefined;
        if (circles.length > 0 || removeCircles.length > 0 || archiveCircles.length > 0) {
          const outcome = this.writeCircleDrafts(
            { circles, removeCircles, archiveCircles },
            plan,
            allowedIds,
            version,
            sharedErrors,
          );
          written.push(...outcome.written);
          removed.push(...outcome.removed);
          unchanged.push(...outcome.unchanged);
        }
        if (occasions.length > 0 || removeOccasions.length > 0) {
          const outcome = this.writeOccasionDrafts(occasions, removeOccasions, plan, allowedIds, version, sharedErrors);
          written.push(...outcome.written);
          removed.push(...outcome.removed);
          unchanged.push(...outcome.unchanged);
        }
        if (before) sharedErrors.push(...this.limitProblems(before));
        if (sharedErrors.length > 0) throw new WriteRefused(sharedErrors);
        return { ok: true as const, written, removed, unchanged };
      });
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, errors: error.errors };
      throw error;
    }
  }

  /** Whether a member id is someone the bot knows (an identities row, a LINKED_ACCOUNTS id, or `allowedIds`). */
  private knownMembers(allowedIds: string[]): (mainId: string) => boolean {
    const known = new Set([...allowedIds.map((id) => canonicalUserId(id)), ...config.server.linkedAccounts.values()]);
    return (id) =>
      known.has(id) || this.memory.getIdentityById(id) !== undefined || config.server.linkedAccounts.has(id);
  }

  /** A draft's members (or participants) as stored: main ids, each once, known to the bot; problems to `errors`. */
  private resolveMembers(
    drafts: CircleMemberDraft[],
    label: string,
    what: string,
    isKnown: (mainId: string) => boolean,
    errors: string[],
  ): CircleMember[] {
    const members: CircleMember[] = [];
    for (const m of drafts) {
      const main = canonicalUserId(m.id);
      if (members.some((x) => x.memberId === main)) {
        errors.push(`${label}: ${what} ${m.id} is listed twice (linked accounts are one member)`);
        continue;
      }
      if (!isKnown(main)) {
        errors.push(`${label}: ${what} ${m.id} is nobody the bot knows`);
        continue;
      }
      members.push({ memberId: main, since: m.since ?? null, until: m.until ?? null, role: m.role ?? null });
    }
    return members.sort(byMembership);
  }

  /**
   * The circle half of write(), inside its transaction: writes, merges, archives and removals. Problems go
   * to `errors` (write() throws WriteRefused with all of them); the members of every circle it touches go
   * (the limits are checked once everything is written: write()).
   */
  private writeCircleDrafts(
    work: { circles: CircleDraft[]; removeCircles: string[]; archiveCircles: string[] },
    plan: { circlesMustInclude?: string; circleActivity?: WriteNotesOptions['circleActivity'] },
    allowedIds: string[],
    version: (fields: Omit<VersionInput, 'at' | 'updatedBy' | 'reason'>, why?: string | null) => VersionInput,
    errors: string[],
  ): { written: Note[]; removed: Note[]; unchanged: string[] } {
    const isKnown = this.knownMembers(allowedIds);
    const mustInclude = plan.circlesMustInclude ? canonicalUserId(plan.circlesMustInclude) : undefined;
    const includesOwner = (members: CircleMember[]) => !mustInclude || members.some((m) => m.memberId === mustInclude);
    const archive = new Set(work.archiveCircles);
    const archiveMonth = easternToday(this.now()).slice(0, 7);

    const written: Note[] = [];
    const removed: Note[] = [];
    const unchanged: string[] = [];

    const deactivate = (slug: string, label: string, why?: string | null): Note | undefined => {
      const existing = this.anyNote('circle', '', slug);
      if (!existing?.active) {
        errors.push(`${label} "${slug}" is not an active circle`);
        return undefined;
      }
      if (!includesOwner(existing.members)) {
        errors.push(`circle "${slug}": a person's notes only change circles they are part of`);
        return undefined;
      }
      const gone = this.putVersion(
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
            details: detailsOf(existing),
            active: false,
          },
          why,
        ),
      );
      removed.push(gone);
      return gone;
    };

    for (const draft of work.circles) {
      const label = `circle "${draft.slug}"`;
      const resolved = this.resolveMembers(draft.members, label, 'member', isKnown, errors);
      const members = archive.has(draft.slug) ? endCurrentMemberships(resolved, archiveMonth) : resolved;
      const existing = this.anyNote('circle', '', draft.slug);
      if (!includesOwner(members) || (existing?.active && !includesOwner(existing.members))) {
        errors.push(`${label}: a person's notes only change circles they are part of`);
        continue;
      }
      // The merged-away circles' versions are recorded on the kept circle's new version, so undoing the merge
      // brings them back with it (undo()).
      const linked: LinkedVersion[] = [];
      for (const merged of draft.merged_from) {
        const gone = deactivate(merged, `${label}: merged_from`, `merged into ${draft.slug}`);
        if (gone) linked.push({ noteId: gone.id, version: gone.version });
      }
      // Written without being archived, a circle is live: an archived one comes back (revived).
      const details: NoteDetails = { ...LIVE_CIRCLE, status: archive.has(draft.slug) ? ARCHIVED_STATUS : null };
      if (
        linked.length === 0 &&
        existing?.active &&
        existing.title === draft.title &&
        existing.content === draft.content &&
        JSON.stringify(existing.aliases) === JSON.stringify(draft.aliases) &&
        sameMembers(existing.members, members) &&
        sameDetails(detailsOf(existing), details)
      ) {
        unchanged.push(`circle:${draft.slug}`);
        continue;
      }
      const saved = this.putVersion(
        'circle',
        '',
        draft.slug,
        existing,
        version({
          title: draft.title,
          content: draft.content,
          aliases: draft.aliases,
          members,
          details,
          active: true,
          linked,
        }),
      );
      // Written back by a writer (a dream, an owner edit): a real return, not a provisional one.
      if (existing?.active && isArchived(existing) && details.status === null) this.markRevival(saved.id);
      written.push(saved);
    }
    for (const slug of work.removeCircles) deactivate(slug, 'removed circle');

    // Circles archived as they are (one written above was archived with its new content already).
    for (const slug of work.archiveCircles) {
      if (work.circles.some((c) => c.slug === slug)) continue;
      const existing = this.anyNote('circle', '', slug);
      if (!existing?.active) {
        errors.push(`archived circle "${slug}" is not an active circle`);
        continue;
      }
      if (!includesOwner(existing.members)) {
        errors.push(`circle "${slug}": a person's notes only change circles they are part of`);
        continue;
      }
      if (isArchived(existing)) {
        unchanged.push(`circle:${slug}`);
        continue;
      }
      written.push(
        this.putVersion(
          'circle',
          '',
          slug,
          existing,
          version({
            title: existing.title,
            content: existing.content,
            aliases: existing.aliases,
            members: endCurrentMemberships(existing.members, archiveMonth),
            details: { ...LIVE_CIRCLE, status: ARCHIVED_STATUS },
            active: true,
          }),
        ),
      );
    }
    // A tree's activity for the circles it writes, before the limits are checked (write()).
    for (const draft of work.circles) {
      const months = plan.circleActivity?.get(draft.slug);
      const note = months ? this.anyNote('circle', '', draft.slug) : undefined;
      if (months && note?.active) this.writeActivity(note.id, months, 'max');
    }
    return { written, removed, unchanged };
  }

  /**
   * The occasion half of write(), inside its transaction: writes and removals, then the occasion limit.
   * Problems go to `errors` (write() throws WriteRefused with all of them).
   */
  private writeOccasionDrafts(
    occasions: OccasionDraft[],
    removeOccasions: string[],
    plan: { circlesMustInclude?: string },
    allowedIds: string[],
    version: (fields: Omit<VersionInput, 'at' | 'updatedBy' | 'reason'>, why?: string | null) => VersionInput,
    errors: string[],
  ): { written: Note[]; removed: Note[]; unchanged: string[] } {
    const isKnown = this.knownMembers(allowedIds);
    const mustInclude = plan.circlesMustInclude ? canonicalUserId(plan.circlesMustInclude) : undefined;
    const includesOwner = (members: CircleMember[]) => !mustInclude || members.some((m) => m.memberId === mustInclude);
    const today = easternToday(this.now());
    const written: Note[] = [];
    const removed: Note[] = [];
    const unchanged: string[] = [];

    for (const draft of occasions) {
      const label = `occasion "${draft.slug}"`;
      const members = this.resolveMembers(draft.participants, label, 'participant', isKnown, errors);
      const existing = this.anyNote('occasion', '', draft.slug);
      const current = existing?.active ? existing : undefined;
      if (!includesOwner(members) || (current && !includesOwner(current.members))) {
        errors.push(`${label}: a person's notes only change occasions they take part in`);
        continue;
      }
      if (draft.circle && !this.anyNote('circle', '', draft.circle)?.active) {
        errors.push(`${label}: "circle" ${draft.circle} is not a circle (give an existing circle's slug, or null)`);
        continue;
      }
      const details: NoteDetails = {
        status: draft.status ?? current?.status ?? defaultOccasionStatus(draft.starts_on, draft.ends_on, today),
        startsOn: draft.starts_on,
        endsOn: draft.ends_on,
        place: draft.place,
        circle: draft.circle,
      };
      if (
        current &&
        current.title === draft.title &&
        current.content === draft.content &&
        JSON.stringify(current.aliases) === JSON.stringify(draft.aliases) &&
        sameMembers(current.members, members) &&
        sameDetails(detailsOf(current), details)
      ) {
        unchanged.push(`occasion:${draft.slug}`);
        continue;
      }
      written.push(
        this.putVersion(
          'occasion',
          '',
          draft.slug,
          existing,
          version({
            title: draft.title,
            content: draft.content,
            aliases: draft.aliases,
            members,
            details,
            active: true,
          }),
        ),
      );
    }
    for (const slug of removeOccasions) {
      const existing = this.anyNote('occasion', '', slug);
      if (!existing?.active) {
        errors.push(`removed occasion "${slug}" is not an active occasion`);
        continue;
      }
      if (!includesOwner(existing.members)) {
        errors.push(`occasion "${slug}": a person's notes only change occasions they take part in`);
        continue;
      }
      removed.push(
        this.putVersion(
          'occasion',
          '',
          slug,
          existing,
          version({
            title: existing.title,
            content: existing.content,
            aliases: existing.aliases,
            members: existing.members,
            details: detailsOf(existing),
            active: false,
          }),
        ),
      );
    }
    return { written, removed, unchanged };
  }

  /**
   * The shared notes' counts the limits apply to: live circles (present and fading; archived ones never
   * count), occasions that aren't archived, and each member's current places in PRESENT circles
   * (lifecycle.ts circlePresence: a fading or archived circle doesn't count, so a member's old circles never
   * crowd out their real ones).
   */
  private limitSnapshot(): LimitSnapshot {
    const count = (scope: SharedScope) =>
      (
        this.stmt(`SELECT COUNT(*) AS n FROM notes n WHERE n.scope = ? AND n.active = 1 AND ${LIVE}`).get(scope) as {
          n: number;
        }
      ).n;
    const rows = this.stmt(
      `SELECT m.member_id, n.id FROM note_members m JOIN notes n ON n.id = m.note_id
       WHERE m.until IS NULL AND n.active = 1 AND n.scope = 'circle' AND ${LIVE}`,
    ).all() as { member_id: string; id: number }[];
    const activity = this.circleActivity();
    const today = easternToday(this.now());
    const presence = new Map<number, boolean>();
    const isPresent = (id: number) => {
      let present = presence.get(id);
      if (present === undefined) {
        const circle = this.getNoteById(id);
        present = circle !== undefined && circlePresence(circle, activity.get(id) ?? [], today).state === 'present';
        presence.set(id, present);
      }
      return present;
    };
    const perMember = new Map<string, number>();
    for (const row of rows) {
      if (isPresent(row.id)) perMember.set(row.member_id, (perMember.get(row.member_id) ?? 0) + 1);
    }
    return { circles: count('circle'), occasions: count('occasion'), perMember };
  }

  /**
   * The limits after a write, against `before` (limitSnapshot): a count over its limit is refused only when
   * the write made it worse, so a store already past a limit (a revival postponed too late, a limit lowered)
   * never blocks writes that don't add to it.
   */
  private limitProblems(before: LimitSnapshot): string[] {
    const after = this.limitSnapshot();
    const problems: string[] = [];
    if (after.circles > NOTE_LIMITS.maxCircles && after.circles > before.circles) {
      problems.push(`${after.circles} circles, over the limit of ${NOTE_LIMITS.maxCircles}`);
    }
    if (after.occasions > NOTE_LIMITS.maxOccasions && after.occasions > before.occasions) {
      problems.push(`${after.occasions} occasions that aren't archived, over the limit of ${NOTE_LIMITS.maxOccasions}`);
    }
    for (const [member, present] of after.perMember) {
      if (present <= NOTE_LIMITS.maxCirclesPerMember || present <= (before.perMember.get(member) ?? 0)) continue;
      problems.push(
        `member ${member} would be current in ${present} present circles, over the limit of ${NOTE_LIMITS.maxCirclesPerMember} (fading and archived circles don't count): give someone who drifted away an "until", or archive a circle that is over`,
      );
    }
    return problems;
  }

  /**
   * Restores the version before a note's current one as a new version (updated_by 'undo'): its title,
   * content, aliases, a circle's or occasion's membership and details (status, dates, place: undoing an
   * archive brings the circle or occasion back live, with its full text), and whether it was active.
   * Undoing twice restores what the first undo replaced. Refused for a note with no earlier version, and
   * when bringing a removed topic, circle or occasion back would pass a limit.
   *
   * A version that merged other circles away (merged_from) is undone together with the merge: each circle
   * it deactivated comes back to its version before the merge, in the same transaction, unless something
   * changed that circle since (it is then left alone). A circle created by a merge (its first version) can
   * be undone too: it is removed and the circles it merged come back. The undo's version records what it
   * brought back, so undoing the undo merges them away again.
   */
  undo(noteId: number, opts: { reason?: string } = {}): UndoResult {
    const note = this.getNoteById(noteId);
    if (!note) return { ok: false, error: 'no such note' };
    const linked = this.linkedOf(noteId, note.version);
    const previous = this.getVersion(noteId, note.version - 1);
    if (!previous && linked.length === 0) return { ok: false, error: 'there is no earlier version to go back to' };

    const owner = ownerOf(note);
    if (owner && previous?.active && !note.active && this.listNotes(owner).length >= maxTopicsFor(owner.scope)) {
      return { ok: false, error: 'bringing that topic back would pass the topic limit' };
    }
    const scope = note.scope;
    const ownerId = note.ownerId ?? '';
    const at = toSqliteUtc(this.now());
    try {
      const outcome = this.runInTransaction(() => {
        const before = isSharedScope(scope) || linked.length > 0 ? this.limitSnapshot() : undefined;
        const alsoRestored: Note[] = [];
        const reverted: LinkedVersion[] = [];
        for (const link of linked) {
          const other = this.getNoteById(link.noteId);
          // Changed since the merge (brought back by hand, merged again): not this undo's to touch.
          if (!other || other.version !== link.version) continue;
          const before = this.getVersion(link.noteId, link.version - 1);
          if (!before) continue;
          const back = this.putVersion(other.scope, other.ownerId ?? '', other.topic, other, {
            title: before.title,
            content: before.content,
            aliases: before.aliases,
            members: isSharedScope(other.scope) ? (before.members ?? other.members) : null,
            details: restoredDetails(other, before),
            active: before.active,
            at,
            updatedBy: 'undo',
            reason: `undo of v${link.version} with ${note.topic} v${note.version} (back to v${before.version})`,
          });
          alsoRestored.push(back);
          reverted.push({ noteId: back.id, version: back.version });
        }
        const brought = alsoRestored.length > 0 ? `; ${alsoRestored.map((n) => n.topic).join(', ')} too` : '';
        const result = this.putVersion(scope, ownerId, note.topic, note, {
          title: previous?.title ?? note.title,
          content: previous?.content ?? note.content,
          aliases: previous?.aliases ?? note.aliases,
          members: isSharedScope(scope) ? (previous?.members ?? note.members) : null,
          details: previous ? restoredDetails(note, previous) : detailsOf(note),
          // No earlier version: a circle a merge created, removed by its undo.
          active: previous ? previous.active : false,
          at,
          updatedBy: 'undo',
          reason: (
            opts.reason ??
            `undo of v${note.version} (${previous ? `back to v${previous.version}` : 'removed'}${brought})`
          ).slice(0, MAX_REASON_CHARS),
          linked: reverted,
        });
        // An archive undone: the circle is back, for real (not archived again the same night).
        if (scope === 'circle' && note.active && isArchived(note) && result.active && !isArchived(result)) {
          this.markRevival(result.id);
        }
        if (before) {
          const problems = this.limitProblems(before);
          if (problems.length > 0) throw new WriteRefused(problems);
        }
        return { note: result, alsoRestored };
      });
      return { ok: true, ...outcome };
    } catch (error) {
      if (error instanceof WriteRefused) return { ok: false, error: error.errors.join('; ') };
      throw error;
    }
  }

  /**
   * Whether undo() has something to go back to for a note's current version: an earlier version, or the
   * circles its version merged away (a circle a merge created).
   */
  canUndo(noteId: number): boolean {
    const note = this.getNoteById(noteId);
    if (!note) return false;
    return note.version > 1 || this.linkedOf(noteId, note.version).length > 0;
  }

  /** The other notes' versions a version's write made along with it (a merge's merged-away circles). */
  private linkedOf(noteId: number, version: number): LinkedVersion[] {
    const row = this.stmt('SELECT linked FROM note_versions WHERE note_id = ? AND version = ?').get(noteId, version) as
      | { linked: string | null }
      | undefined;
    return parseJsonArray(row?.linked, isLinkedVersion);
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
    const details = isSharedScope(scope) ? (next.details ?? LIVE_CIRCLE) : null;
    const columns = [
      details?.startsOn ?? null,
      details?.endsOn ?? null,
      details?.place ?? null,
      details?.status ?? null,
      details?.circle ?? null,
    ];
    let id: number;
    let version: number;
    if (existing) {
      id = existing.id;
      version = existing.version + 1;
      this.stmt(
        `UPDATE notes SET title = ?, content = ?, aliases = ?, version = ?, updated_at = ?, updated_by = ?, active = ?,
           starts_on = ?, ends_on = ?, place = ?, status = ?, circle = ?
         WHERE id = ?`,
      ).run(next.title, next.content, aliases, version, next.at, next.updatedBy, next.active ? 1 : 0, ...columns, id);
    } else {
      version = 1;
      id = Number(
        this.stmt(
          `INSERT INTO notes (scope, owner_id, topic, title, content, aliases, version, updated_at, updated_by, active,
             starts_on, ends_on, place, status, circle)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          scope,
          ownerId,
          topic,
          next.title,
          next.content,
          aliases,
          next.at,
          next.updatedBy,
          next.active ? 1 : 0,
          ...columns,
        ).lastInsertRowid,
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
      `INSERT INTO note_versions
         (note_id, version, title, content, aliases, members, active, updated_at, updated_by, reason, linked, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      next.linked && next.linked.length > 0 ? JSON.stringify(next.linked) : null,
      details ? JSON.stringify(details) : null,
    );
    const note = this.getNoteById(id);
    if (!note) throw new Error(`note #${id} vanished while it was written`);
    return note;
  }

  private toNote(row: NoteRow): Note {
    const shared = isSharedScope(row.scope);
    const members = shared
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
      status: shared ? statusOrNull(row.status) : null,
      startsOn: row.scope === 'occasion' ? row.starts_on : null,
      endsOn: row.scope === 'occasion' ? row.ends_on : null,
      place: row.scope === 'occasion' ? row.place : null,
      circle: row.scope === 'occasion' ? row.circle : null,
    };
  }

  // ---- Circle activity (lifecycle.ts CIRCLE_DECAY) ----

  /** A note's activity by month, oldest first. */
  activityOf(noteId: number): ActivityMonth[] {
    const rows = this.stmt(
      'SELECT month, weight, ambient, revival FROM note_activity WHERE note_id = ? ORDER BY month',
    ).all(noteId) as ActivityRow[];
    return rows.map(toActivityMonth);
  }

  /** Every active circle's activity by note id, oldest month first (circles without any are left out). */
  circleActivity(): Map<number, ActivityMonth[]> {
    const rows = this.stmt(
      `SELECT a.note_id, a.month, a.weight, a.ambient, a.revival FROM note_activity a JOIN notes n ON n.id = a.note_id
       WHERE n.scope = 'circle' AND n.active = 1 ORDER BY a.note_id, a.month`,
    ).all() as (ActivityRow & { note_id: number })[];
    const byNote = new Map<number, ActivityMonth[]>();
    for (const r of rows) {
      const list = byNote.get(r.note_id) ?? [];
      list.push(toActivityMonth(r));
      byNote.set(r.note_id, list);
    }
    return byNote;
  }

  /**
   * Records a circle's activity: `months` (`YYYY-MM` → a positive whole weight) added to what is there
   * (`mode: 'add'`: the journal rows a dream folded that name it) or raised to it (`'max'`: a seed, a linked
   * occasion; running it twice changes nothing); `opts.ambient` (rows about two of its members that named no
   * circle) is added up to CIRCLE_DECAY.ambientMonthCap a month and never revives anything. Malformed months
   * and weights are skipped. With `revive`, an archived circle that gets new weight in or after the month it
   * was archived comes back (lifecycle.ts: as fading until its return is real): a dream version with its
   * status live, its text as archived, the members behind the reviving activity (`opts.members`) current
   * again, and the newest month marked as its revival. A revival that would pass a limit (the live circles,
   * a member's present circles) is postponed (`postponed`: why), the activity kept. Only for an active
   * circle. The callers count only activity that involves two or more of its members: a circle is a shared
   * thing.
   */
  recordActivity(
    noteId: number,
    months: Readonly<Record<string, number>>,
    opts: {
      mode: 'add' | 'max';
      revive?: boolean;
      reason?: string;
      ambient?: Readonly<Record<string, number>>;
      members?: Iterable<string>;
    },
  ): { ok: true; changed: string[]; revived?: Note; postponed?: string[] } | { ok: false; error: string } {
    return this.runInTransaction(() => {
      const note = this.getNoteById(noteId);
      if (!note?.active || note.scope !== 'circle') {
        return { ok: false as const, error: 'only an active circle has activity' };
      }
      const changed = this.writeActivity(noteId, months, opts.mode);
      if (opts.ambient) this.writeAmbient(noteId, opts.ambient);
      const newest = changed.at(-1);
      const archivedIn = easternDayOfTimestamp(note.updatedAt)?.slice(0, 7) ?? '';
      if (!opts.revive || !isArchived(note) || !newest || newest < archivedIn) return { ok: true as const, changed };
      const back = new Set([...(opts.members ?? [])].map((id) => canonicalUserId(id)));
      const before = this.limitSnapshot();
      try {
        const revived = this.runInTransaction(() => {
          this.stmt('UPDATE note_activity SET revival = 1 WHERE note_id = ? AND month = ?').run(noteId, newest);
          const version = this.putVersion('circle', '', note.topic, note, {
            title: note.title,
            content: note.content,
            aliases: note.aliases,
            members: note.members.map((m) => (back.has(canonicalUserId(m.memberId)) ? { ...m, until: null } : m)),
            details: LIVE_CIRCLE,
            active: true,
            at: toSqliteUtc(this.now()),
            updatedBy: 'dream',
            reason: `came back${opts.reason ? `: ${opts.reason}` : ''}`.slice(0, MAX_REASON_CHARS),
          });
          const problems = this.limitProblems(before);
          if (problems.length > 0) throw new WriteRefused(problems);
          return version;
        });
        return { ok: true as const, changed, revived };
      } catch (error) {
        if (!(error instanceof WriteRefused)) throw error;
        logger.info(`notes: circle "${note.topic}" has new shared activity but can't come back yet: ${error.message}`);
        return { ok: true as const, changed, postponed: error.errors };
      }
    });
  }

  /** Ambient sightings added to a note's months, each month capped at CIRCLE_DECAY.ambientMonthCap. */
  private writeAmbient(noteId: number, months: Readonly<Record<string, number>>): void {
    const write = this.stmt(
      `INSERT INTO note_activity (note_id, month, ambient) VALUES (@id, @month, MIN(@add, @cap))
       ON CONFLICT(note_id, month) DO UPDATE SET ambient = MIN(ambient + @add, @cap)`,
    );
    for (const [month, add] of Object.entries(months)) {
      if (!ACTIVITY_MONTH.test(month) || !Number.isInteger(add) || add <= 0) continue;
      write.run({ id: noteId, month, add, cap: CIRCLE_DECAY.ambientMonthCap });
    }
  }

  /** The months' weights added to (or raised to) a note's activity; the months that changed, sorted. */
  private writeActivity(noteId: number, months: Readonly<Record<string, number>>, mode: 'add' | 'max'): string[] {
    const read = this.stmt('SELECT weight FROM note_activity WHERE note_id = ? AND month = ?');
    const write = this.stmt(
      `INSERT INTO note_activity (note_id, month, weight) VALUES (?, ?, ?)
       ON CONFLICT(note_id, month) DO UPDATE SET weight = excluded.weight`,
    );
    const changed: string[] = [];
    for (const [month, weight] of Object.entries(months)) {
      if (!ACTIVITY_MONTH.test(month) || !Number.isInteger(weight) || weight <= 0) continue;
      const before = (read.get(noteId, month) as { weight: number } | undefined)?.weight ?? 0;
      const after = mode === 'add' ? before + weight : Math.max(before, weight);
      if (after === before) continue;
      write.run(noteId, month, after);
      changed.push(month);
    }
    return changed.sort();
  }

  /**
   * A writer brought an archived circle back (a dream or an owner edit writing it again, an undo of its
   * archive): this month counts as a real return (CIRCLE_DECAY.realReturnWeight) and is marked as a
   * revival, so the circle is present again instead of archived the same night.
   */
  private markRevival(noteId: number): void {
    this.stmt(
      `INSERT INTO note_activity (note_id, month, weight, revival) VALUES (?, ?, ?, 1)
       ON CONFLICT(note_id, month) DO UPDATE SET weight = MAX(weight, excluded.weight), revival = 1`,
    ).run(noteId, easternToday(this.now()).slice(0, 7), CIRCLE_DECAY.realReturnWeight);
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
    const kindFilter = `${
      kinds === 'corrections'
        ? `AND category = '${CORRECTION_CATEGORY}'`
        : kinds === 'observations'
          ? `AND category != '${CORRECTION_CATEGORY}'`
          : ''
    } ${opts.dream ? `AND category NOT IN (${DREAM_EXCLUDED_NOT_IN})` : ''}`;
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

  /**
   * The journal rows the occasion pass reads for an occasion, oldest first: rows about any of its
   * participants (stamped with one of their account ids, or naming them among related members) seen from
   * OCCASION_LIFECYCLE.journalDaysBefore days before it started to journalDaysAfter days after it ended
   * (Eastern days, by first/last seen); then their rows and the server's that name it (title, slug words or
   * alias) from further around (OCCASION_NAMED_WINDOW). At most MAX_OCCASION_JOURNAL_ROWS (the window's
   * newest first, then the named ones). Self-diagnosis and DREAM_EXCLUDED_CATEGORIES rows never.
   */
  occasionJournal(occasion: Note): Memory[] {
    if (occasion.scope !== 'occasion' || !occasion.startsOn) return [];
    const start = partialDateStart(occasion.startsOn);
    const end = occasionEndDay(occasion) ?? start;
    const windowFrom = addDays(start, -OCCASION_LIFECYCLE.journalDaysBefore);
    const windowTo = addDays(end, OCCASION_LIFECYCLE.journalDaysAfter);
    const wideFrom = addDays(start, -OCCASION_NAMED_WINDOW.before);
    const wideTo = addDays(end, OCCASION_NAMED_WINDOW.after);
    const ids = JSON.stringify([...new Set(occasion.members.flatMap((m) => accountIdsFor(m.memberId)))]);
    // A day of slack on each side: the bounds are Eastern days, the timestamps UTC.
    const rows = this.stmt(
      `SELECT * FROM memories
       WHERE active = 1
         AND (subject_user_id IN (SELECT value FROM json_each(@ids))
              OR EXISTS (SELECT 1 FROM json_each(memories.related_user_ids) r
                         WHERE r.value IN (SELECT value FROM json_each(@ids)))
              OR (subject_user_id IS NULL AND lower(subject) IN (SELECT value FROM json_each(@group))))
         AND COALESCE(last_seen_at, updated_at) >= @from AND COALESCE(first_seen_at, created_at) <= @to
         AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) AND category NOT IN (${DREAM_EXCLUDED_NOT_IN})
       ORDER BY journal_seq ASC`,
    ).all({
      ids,
      group: GROUP_SUBJECTS,
      from: `${addDays(wideFrom, -1)} 00:00:00`,
      to: `${addDays(wideTo, 1)} 23:59:59`,
    }) as Memory[];
    const span = (row: Memory) => ({
      first: easternDayOfTimestamp(row.first_seen_at ?? row.created_at) ?? '',
      last: easternDayOfTimestamp(row.last_seen_at ?? row.updated_at) ?? '',
    });
    const isServerRow = (row: Memory) => !row.subject_user_id && relatedUserIdsOf(row).length === 0;
    const within = (row: Memory, from: string, to: string) => {
      const { first, last } = span(row);
      return last >= from && first <= to;
    };
    const core = rows.filter((row) => !isServerRow(row) && within(row, windowFrom, windowTo));
    const named = rows.filter(
      (row) =>
        !core.includes(row) && within(row, wideFrom, wideTo) && circlesNamedIn(row.content, [occasion]).length > 0,
    );
    const kept = core.slice(-MAX_OCCASION_JOURNAL_ROWS);
    const room = MAX_OCCASION_JOURNAL_ROWS - kept.length;
    if (room > 0) kept.push(...named.slice(-room));
    return kept.sort((a, b) => (a.journal_seq ?? a.id) - (b.journal_seq ?? b.id));
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
   * Owners with journal rows a dream reads (DREAM_EXCLUDED_CATEGORIES aside) above their watermark, most
   * recently active first: people (by the id their
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
   *
   * People whose last dream failed come after everyone else (then most recently active first), so a few
   * people whose dreams keep failing never take the night's places (`limit`) from the rest.
   */
  pendingDreams(opts: { limit?: number } = {}): { people: PendingDream[]; group?: PendingDream } {
    const rows = this.stmt(
      `SELECT subject_user_id AS uid, related_user_ids AS related, journal_seq AS seq, source FROM memories
       WHERE active = 1 AND (subject_user_id IS NOT NULL OR related_user_ids IS NOT NULL)
         AND category NOT IN (${SELF_DIAGNOSIS_NOT_IN}) AND category NOT IN (${DREAM_EXCLUDED_NOT_IN})`,
    ).all() as { uid: string | null; related: string | null; seq: number; source: string | null }[];

    const states = new Map<string, DreamState>();
    const byOwner = new Map<string, { newRows: number; latestSeq: number }>();
    // Ids some row vouches for: stamped by a writer other than the old learner, or a related member.
    const vouched = new Set<string>();
    const stateOf = (id: string) => {
      let state = states.get(id);
      if (state === undefined) {
        state = this.getDreamState({ scope: 'person', ownerId: id });
        states.set(id, state);
      }
      return state;
    };
    for (const row of rows) {
      const related = parseJsonArray(row.related, isString).map((id) => canonicalUserId(id));
      const uid = row.uid ? canonicalUserId(row.uid) : undefined;
      if (uid && !LEARNER_SOURCE_SET.has(row.source ?? '')) vouched.add(uid);
      for (const id of related) vouched.add(id);
      const owners = new Set([...(uid ? [uid] : []), ...related]);
      for (const main of owners) {
        if (row.seq <= stateOf(main).journalWatermark) continue;
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
      .sort((a, b) => {
        const failedA = stateOf(a.owner.ownerId).lastError !== null;
        const failedB = stateOf(b.owner.ownerId).lastError !== null;
        return failedA !== failedB ? (failedA ? 1 : -1) : b.latestSeq - a.latestSeq;
      })
      .slice(0, opts.limit ?? Number.POSITIVE_INFINITY);

    const groupRows = this.newJournal({ scope: 'group' }, { dream: true });
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
