// The bootstrap's drop-in import (docs/memory.md "Bootstrap" §3). A notes tree (notesTree.ts) placed in
// data/memory-import/ is loaded at startup, before anything can dream:
//   1. read and shape-check every file; check every person and circle member against who the bot knows
//      (identities, LINKED_ACCOUNTS, and the archive's authors: people who left before the bot saw them
//      get an identities row under the last name they posted with);
//   2. in ONE memory.db transaction: write every note as a new version (updated_by 'bootstrap'),
//      removing an imported person's (and, with a group/ folder, the group's) topics the tree doesn't
//      have and, with a circles/ folder, the circles it doesn't have; then move the imported owners'
//      dream watermarks to the manifest's journal high-water mark, so the next dream only folds in
//      journal rows written after the export;
//   3. move the tree into data/memory-import/imported-<timestamp>/ and log it; the report channel gets
//      one line once the bot is ready (src/events/memoryImportReport.ts).
// A tree with any problem loads nothing: every problem is logged and the folder stays where it is.
// `check` runs the very same loader against a scratch in-memory store, so a tree that passes it imports.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ArchiveStore, getArchiveStore } from '../../../archive/archiveStore';
import { config } from '../../../config';
import { canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import { foldMembers } from '../../people';
import { getMemoryStore, getNotesStore } from '../index';
import { MemoryStore } from '../memoryStore';
import { NotesStore } from '../notes/notesStore';
import type { NoteOwner } from '../notes/schema';
import { hasNotesTree, type NotesTree, type NotesTreeRead, readNotesTree } from './notesTree';

/** Where the bot looks for a notes tree at startup. */
export const DEFAULT_IMPORT_DIR = './data/memory-import';

/** Who notes may be about: main id → a name, plus side accounts that must not own notes. */
export type KnownPeople = {
  names: Map<string, string>;
  /** Side account → main account. */
  sides: Map<string, string>;
  /** Where the list came from (for messages). */
  source: string;
};

export type ImportSummary = {
  people: number;
  groupTopics: number;
  circles: number;
  /** Note and circle versions written. */
  written: number;
  /** Already identical: no new version. */
  unchanged: number;
  /** Topics and circles removed because the tree doesn't have them. */
  removed: number;
  /** Identities rows added for people only the archive knew. */
  identitiesAdded: number;
  /** The dream watermark the imported owners moved to. */
  watermark: number;
};

export type LoadResult = { ok: true; summary: ImportSummary } | { ok: false; errors: string[] };

class ImportRefused extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join('; '));
  }
}

/** Everyone the bot knows (identities, LINKED_ACCOUNTS) plus everyone the archive holds messages from. */
export function knownPeopleFromStores(memory: MemoryStore, archive?: ArchiveStore): KnownPeople {
  const names = new Map<string, string>();
  for (const member of foldMembers(memory.getAllIdentities())) names.set(member.userId, member.displayName);
  const sides = new Map(config.server.linkedAccounts);
  if (archive) {
    const latest = new Map<string, number>();
    for (const row of archive.authorSummary()) {
      if (row.bot || !row.authorId) continue;
      const id = canonicalUserId(row.authorId);
      if (names.has(id) && !latest.has(id)) continue;
      if ((latest.get(id) ?? Number.NEGATIVE_INFINITY) < row.lastAt) {
        latest.set(id, row.lastAt);
        names.set(id, row.authorName);
      }
    }
  }
  return { names, sides, source: archive ? 'the identities table and the archive' : 'the identities table' };
}

/** The people an export's people.json lists (check mode away from the bot's databases). */
export function knownPeopleFromJson(file: string): { ok: true; known: KnownPeople } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const people = (raw as { people?: unknown } | null)?.people;
  if (!people || typeof people !== 'object' || Array.isArray(people)) {
    return { ok: false, error: `${file}: not an export's people.json (no "people" object)` };
  }
  const names = new Map<string, string>();
  const sides = new Map<string, string>();
  for (const [name, entry] of Object.entries(people as Record<string, unknown>)) {
    const { id, accounts } = (entry ?? {}) as { id?: unknown; accounts?: unknown };
    if (typeof id !== 'string') continue;
    names.set(id, name);
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (typeof account === 'string' && account !== id) sides.set(account, id);
    }
  }
  return { ok: true, known: { names, sides, source: file } };
}

/** Problems with who the tree's notes are about, before anything is written. */
function peopleProblems(tree: NotesTree, known: KnownPeople): string[] {
  const errors: string[] = [];
  const mainOf = (id: string) => known.sides.get(id) ?? canonicalUserId(id);
  for (const person of tree.people) {
    const main = mainOf(person.id);
    if (main !== person.id) {
      errors.push(`people/${person.id}: a linked side account; notes belong to its main account (people/${main})`);
    } else if (!known.names.has(person.id)) {
      errors.push(`people/${person.id}: nobody ${known.source} knows`);
    }
  }
  for (const circle of tree.circles ?? []) {
    for (const member of circle.members) {
      const main = mainOf(member.id);
      if (main !== member.id) {
        errors.push(`circles/${circle.slug}.md: member ${member.id} is a linked side account; use ${main}`);
      } else if (!known.names.has(member.id)) {
        errors.push(`circles/${circle.slug}.md: member ${member.id} is nobody ${known.source} knows`);
      }
    }
  }
  return errors;
}

/**
 * Loads a read tree into the stores, all or nothing (see the file comment). With `checkHighWater`, a
 * manifest whose journal high-water mark is above this journal's is refused (an export of another
 * database, or a journal that was reset): its watermark would hide rows no note was built from.
 */
export function loadNotesTree(
  tree: NotesTree,
  deps: { memory: MemoryStore; notes: NotesStore; known: KnownPeople; checkHighWater?: boolean; reason?: string },
): LoadResult {
  const { memory, notes, known } = deps;
  const errors = peopleProblems(tree, known);
  const watermark = tree.manifest.journal_high_water;
  if (deps.checkHighWater && watermark > notes.journalHighWater()) {
    errors.push(
      `manifest.json: journal_high_water ${watermark} is above this journal's (${notes.journalHighWater()}): was the export made from another database?`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  const reason = deps.reason ?? 'bootstrap import';
  const summary: ImportSummary = {
    people: tree.people.length,
    groupTopics: tree.group?.length ?? 0,
    circles: tree.circles?.length ?? 0,
    written: 0,
    unchanged: 0,
    removed: 0,
    identitiesAdded: 0,
    watermark,
  };
  const tally = (result: ReturnType<NotesStore['writeNotes']>, label: string) => {
    if (!result.ok) throw new ImportRefused(result.errors.map((e) => `${label}: ${e}`));
    summary.written += result.written.length;
    summary.unchanged += result.unchanged.length;
    summary.removed += result.removed.length;
  };

  try {
    memory.sharedDatabase().transaction(() => {
      // People only the archive knows get an identities row: circle membership needs one, and chat
      // turns name them by it.
      const referenced = new Set([
        ...tree.people.map((p) => p.id),
        ...(tree.circles ?? []).flatMap((c) => c.members.map((m) => m.id)),
      ]);
      for (const id of referenced) {
        if (memory.getIdentityById(id)) continue;
        memory.upsertIdentity(id, known.names.get(id) ?? id);
        summary.identitiesAdded++;
      }

      if (tree.circles) {
        const keep = new Set(tree.circles.map((c) => c.slug));
        const removeCircles = notes
          .listCircles()
          .map((c) => c.topic)
          .filter((slug) => !keep.has(slug));
        tally(
          notes.writeCircles(tree.circles, {
            updatedBy: 'bootstrap',
            reason,
            removeCircles,
            ...(tree.activity ? { circleActivity: tree.activity } : {}),
          }),
          'circles',
        );
      }

      const owners: NoteOwner[] = [];
      for (const person of tree.people) {
        const owner: NoteOwner = { scope: 'person', ownerId: person.id };
        const keep = new Set(person.notes.map((n) => n.topic));
        const removeTopics = notes
          .listNotes(owner)
          .map((n) => n.topic)
          .filter((t) => !keep.has(t));
        tally(
          notes.writeNotes(owner, person.notes, { updatedBy: 'bootstrap', reason, removeTopics }),
          `people/${person.id}`,
        );
        owners.push(owner);
      }

      if (tree.group) {
        const owner: NoteOwner = { scope: 'group' };
        const keep = new Set(tree.group.map((n) => n.topic));
        const removeTopics = notes
          .listNotes(owner)
          .map((n) => n.topic)
          .filter((t) => !keep.has(t));
        tally(notes.writeNotes(owner, tree.group, { updatedBy: 'bootstrap', reason, removeTopics }), 'group');
        owners.push(owner);
      }

      notes.setWatermarks(owners, watermark);
    })();
  } catch (error) {
    if (error instanceof ImportRefused) return { ok: false, errors: error.errors };
    throw error;
  }
  return { ok: true, summary };
}

export type CheckResult = {
  read: NotesTreeRead;
  load?: LoadResult;
  known?: KnownPeople;
  /** The problems, when any (from reading, or from loading into the scratch store). */
  errors: string[];
  warnings: string[];
};

/**
 * Validates a tree without touching the bot's databases: reads it, then loads it into a scratch
 * in-memory store that knows `known` (the same loader the startup import runs).
 */
export function checkNotesTree(dir: string, known: KnownPeople, opts: { journalHighWater?: number } = {}): CheckResult {
  const read = readNotesTree(dir);
  if (!read.ok) return { read, errors: read.errors, warnings: [] };
  const scratch = new MemoryStore(':memory:');
  try {
    const notes = new NotesStore(scratch);
    for (const [id, name] of known.names) scratch.upsertIdentity(id, name);
    const load = loadNotesTree(read.tree, { memory: scratch, notes, known });
    const errors = load.ok ? [] : [...load.errors];
    if (opts.journalHighWater !== undefined && read.tree.manifest.journal_high_water > opts.journalHighWater) {
      errors.push(
        `manifest.json: journal_high_water ${read.tree.manifest.journal_high_water} is above the journal's (${opts.journalHighWater})`,
      );
    }
    return { read, load, known, errors, warnings: read.warnings };
  } finally {
    scratch.close();
  }
}

/** A filesystem-safe timestamp for the imported folder's name. */
function folderStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/** Moves a tree's entries (not earlier imports) into `<dir>/imported-<stamp>/`; returns that folder. */
function moveAside(dir: string, now: Date): string {
  const target = path.join(dir, `imported-${folderStamp(now)}`);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('imported-')) continue;
    fs.renameSync(path.join(dir, entry), path.join(target, entry));
  }
  return target;
}

export type StartupImportOutcome =
  | { status: 'imported'; summary: ImportSummary; movedTo?: string }
  | { status: 'refused'; errors: string[] };

let pendingReport: string | undefined;

/** The report-channel line of this process's startup import, once (then undefined). */
export function takeImportReport(): string | undefined {
  const report = pendingReport;
  pendingReport = undefined;
  return report;
}

function describeSummary(s: ImportSummary): string {
  const parts = [`${s.people} ${s.people === 1 ? 'person' : 'people'}`];
  if (s.groupTopics > 0) parts.push(`${s.groupTopics} group ${s.groupTopics === 1 ? 'topic' : 'topics'}`);
  if (s.circles > 0) parts.push(`${s.circles} ${s.circles === 1 ? 'circle' : 'circles'}`);
  return parts.join(', ');
}

/**
 * The startup import (see the file comment): nothing to do without a tree in `dir`. Never throws; every
 * outcome is logged, and a report-channel line waits for takeImportReport().
 */
export function importNotesAtStartup(
  opts: { dir?: string; memory?: MemoryStore; notes?: NotesStore; archive?: ArchiveStore; now?: () => Date } = {},
): StartupImportOutcome | undefined {
  const dir = opts.dir ?? DEFAULT_IMPORT_DIR;
  try {
    if (!hasNotesTree(dir)) return undefined;
    const memory = opts.memory ?? getMemoryStore();
    const notes = opts.notes ?? getNotesStore(memory);
    const archive = opts.archive ?? (config.archive.enabled ? getArchiveStore() : undefined);

    const read = readNotesTree(dir);
    for (const warning of read.ok ? read.warnings : []) logger.warn(`memory import: ${warning}`);
    const loaded = read.ok
      ? loadNotesTree(read.tree, { memory, notes, known: knownPeopleFromStores(memory, archive), checkHighWater: true })
      : undefined;
    const errors = !read.ok ? read.errors : loaded && !loaded.ok ? loaded.errors : [];
    if (errors.length > 0 || !loaded?.ok) {
      logger.error(
        `memory import: ${dir} was NOT loaded (${errors.length} problem${errors.length === 1 ? '' : 's'}; nothing changed, the folder stays in place — fix it and restart, or check it with \`memory import --check\`):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      );
      pendingReport = `⚠️ memory import refused: ${errors.length} problem${errors.length === 1 ? '' : 's'} in the notes tree, nothing loaded (see the log)`;
      return { status: 'refused', errors };
    }

    const summary = loaded.summary;
    let movedTo: string | undefined;
    try {
      movedTo = moveAside(dir, (opts.now ?? (() => new Date()))());
    } catch (error) {
      // Loaded but still in place: the next start loads it again, which changes nothing (identical
      // drafts write no version; watermarks never move backwards). Loud, so the owner moves it.
      logger.error(`memory import: loaded, but moving ${dir} aside failed; move it by hand:`, error);
    }
    logger.info(
      `memory import: loaded notes for ${describeSummary(summary)} (${summary.written} versions written, ${summary.unchanged} unchanged, ${summary.removed} removed, ${summary.identitiesAdded} identities added); dream watermarks at journal #${summary.watermark}${movedTo ? `; moved to ${movedTo}` : ''}`,
    );
    pendingReport = `🧠 memory import · notes loaded for ${describeSummary(summary)} · dreams pick up from journal #${summary.watermark}`;
    return { status: 'imported', summary, ...(movedTo ? { movedTo } : {}) };
  } catch (error) {
    logger.error(`memory import: reading ${dir} failed:`, error);
    return { status: 'refused', errors: [error instanceof Error ? error.message : String(error)] };
  }
}
