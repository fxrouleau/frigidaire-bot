// Memory v2's writers (docs/memory.md): the nightly dream that folds each person's new journal rows into
// their notes (and circles), the group pass after it, and the owner's edits. This module is the CONTRACT
// the phase-2 parts build against:
//
// - The dream (dream part) implements dreamPerson(), dreamGroup(), runNightlyDream() and proposeEdit()
//   here, with its prompts, in this file or modules it adds next to it. Every model answer goes through
//   parseNotesOutput() (schema.ts: the JSON output schema and its validator, shared by the dream, owner
//   edits, the import and the built-in bootstrap) and is saved with NotesStore.applyNotesOutput(), all or
//   nothing. The watermark moves (NotesStore.recordDreamSuccess) only after a successful save; a failure is
//   recorded (recordDreamFailure) and retried the next night.
// - The viewer (viewer part) calls proposeEdit() for the owner's Edit button, shows previewChanges() as the
//   before/after, and on Confirm calls applyEdit() with the same proposal (it holds the proposal meanwhile).
//
// Until the dream part lands, the four model-backed functions throw: nothing in production calls them yet.
import type OpenAI from 'openai';
import { canonicalUserId } from '../../../linkedAccounts';
import type { MemoryStore } from '../memoryStore';
import type { Note, NotesStore, WriteNotesResult } from './notesStore';
import type { EvidencePassage, EvidencePassageOptions } from './passages';
import type { CircleMember, NoteOwner, NotesOutput } from './schema';

export type { NotesOutput } from './schema';
export { parseNotesOutput, validateNotesOutput } from './schema';

/** What an owner edit changes: a person's notes (and their circles), the group's, or one circle. */
export type EditTarget = NoteOwner | { scope: 'circle'; slug: string };

/** What the writers need; tests inject every piece. */
export type DreamDeps = {
  notes: NotesStore;
  /** Identities (every name a person goes by) and the journal. */
  memory: MemoryStore;
  /** OpenRouter client (the shared one by default). Calls are ZDR and tagged memory_dream / memory_edit. */
  client?: OpenAI;
  /** MEMORY_DREAM_MODEL (dream) or MEMORY_EDIT_MODEL (edit) by default. */
  model?: string;
  now?: () => Date;
  /**
   * The cited source passages for contested, low-confidence or about-to-be-core claims (journal evidence,
   * src/ai/memory/evidence.ts); passages.ts loadEvidencePassages by default. Capped per person per dream.
   */
  loadPassages?: (messageIds: string[], opts?: EvidencePassageOptions) => EvidencePassage[];
};

/** One owner's dream. */
export type DreamOutcome =
  | {
      status: 'updated';
      owner: NoteOwner;
      /** Notes and circles written (new versions). */
      written: Note[];
      /** Notes and circles removed or merged away. */
      removed: Note[];
      /** The model's few words on what changed (the report line). */
      changeSummary: string;
      /** The journal_seq the watermark moved to. */
      watermark: number;
      /** What the call cost (USD, from the usage response), when reported. */
      costUsd?: number;
    }
  /** The model looked and nothing needed rewriting; the watermark still moved. */
  | { status: 'unchanged'; owner: NoteOwner; watermark: number; costUsd?: number }
  /** Nothing above the watermark: no call was made. */
  | { status: 'skipped'; owner: NoteOwner; reason: 'nothing-new' }
  /** No usable answer (model error, invalid JSON, a refused write): the watermark stays; retried next night. */
  | { status: 'failed'; owner: NoteOwner; error: string };

/** Context the group pass gets from the night's person dreams. */
export type GroupDreamContext = {
  /** Each updated person's change summary, by main id and current name. */
  personChanges: { ownerId: string; name: string; changeSummary: string }[];
};

/** One night's run: every person dreamed (most recently active first, capped), then the group. */
export type NightlyDreamResult = {
  /** The Eastern date of the night (YYYY-MM-DD): the once-a-day watermark. */
  day: string;
  people: DreamOutcome[];
  group?: DreamOutcome;
  /** Total cost of the night's calls (USD), when reported. */
  costUsd?: number;
};

/** The owner's Edit request ("What should change?"). */
export type EditRequest = {
  target: EditTarget;
  /** The owner's instruction, ≤ 4,000 characters (the modal's limit). */
  instruction: string;
  /** Who asked (the owner's main id), for the log. */
  requestedBy: string;
};

/** A drafted edit, ready for the before/after preview and Confirm. */
export type EditProposal =
  | {
      ok: true;
      target: EditTarget;
      /** The validated output (parseNotesOutput with the target's scope). */
      output: NotesOutput;
      /** Ids the output may carry (the same allowedIds it was validated with): applyEdit passes them on. */
      allowedIds: string[];
      changeSummary: string;
    }
  | { ok: false; error: string };

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name} (memory v2 dream part)`);
}

/**
 * Dreams one person (main id): their names, ALL their current notes and circles, the journal rows above
 * their watermark (dated, category, source/speaker, recurrence and seen span, evidence) and, for claims
 * that are contested, low-confidence or about to become core profile facts, the cited passages; today's
 * date. One MEMORY_DREAM_MODEL call; the answer is parsed with parseNotesOutput({ scope: 'person',
 * requireProfile: true, allowedIds }) and saved with applyNotesOutput(..., { updatedBy: 'dream' }); the
 * watermark moves to the highest journal_seq it read. Never throws: failures come back as 'failed'.
 */
export async function dreamPerson(_ownerId: string, _deps: DreamDeps): Promise<DreamOutcome> {
  return notImplemented('dreamPerson');
}

/**
 * The group pass after the people: journal rows about the server (no person) plus the night's person
 * change summaries become the group's notes (lore, running jokes, vibe; server-wide only) and any circles
 * that span the group. Same contract as dreamPerson with scope 'group'.
 */
export async function dreamGroup(_deps: DreamDeps, _context: GroupDreamContext): Promise<DreamOutcome> {
  return notImplemented('dreamGroup');
}

/**
 * One night: NotesStore.pendingDreams({ limit: MEMORY_DREAM_MAX_PEOPLE_PER_NIGHT }) people, one at a time,
 * then the group. The scheduler that calls it (once per Eastern day, on the first tick at/after
 * MEMORY_DREAM_HOUR, catching up the same day, never twice) and the report-channel line belong to the
 * dream part.
 */
export async function runNightlyDream(_deps: DreamDeps & { maxPeople?: number }): Promise<NightlyDreamResult> {
  return notImplemented('runNightlyDream');
}

/**
 * Drafts an owner edit with MEMORY_EDIT_MODEL: the target's current notes (a person's with their circles)
 * plus the instruction, answered as a NotesOutput for the target's scope ('circle' for a circle edit:
 * exactly that circle). Nothing is saved: see previewChanges() and applyEdit().
 */
export async function proposeEdit(_request: EditRequest, _deps: DreamDeps): Promise<EditProposal> {
  return notImplemented('proposeEdit');
}

/** Saves a confirmed edit as new versions (updated_by 'edit', reason = the owner's instruction). */
export function applyEdit(
  proposal: Extract<EditProposal, { ok: true }>,
  instruction: string,
  notes: NotesStore,
): WriteNotesResult {
  return notes.applyNotesOutput(proposal.target, proposal.output, {
    updatedBy: 'edit',
    reason: instruction,
    allowedIds: proposal.allowedIds,
  });
}

/** One note or circle a writer output would change, for a before/after preview. */
export type ProposedChange = {
  kind: 'note' | 'circle';
  /** The topic or circle slug. */
  key: string;
  /** The new title (the current one for a removal). */
  title: string;
  change: 'added' | 'changed' | 'removed';
  /** Current content (absent when added). */
  before?: string;
  /** Proposed content (absent when removed). */
  after?: string;
  /** A circle's membership now / as proposed (main ids). */
  membersBefore?: CircleMember[];
  membersAfter?: CircleMember[];
  /** A circle's aliases now / as proposed. */
  aliasesBefore?: string[];
  aliasesAfter?: string[];
};

function sameMembership(a: CircleMember[], b: CircleMember[]): boolean {
  const key = (list: CircleMember[]) =>
    JSON.stringify([...list].sort((x, y) => (x.memberId < y.memberId ? -1 : x.memberId > y.memberId ? 1 : 0)));
  return key(a) === key(b);
}

/**
 * What saving `output` for `target` would change, against the store's current state: notes added,
 * changed or removed, circles added, changed (content, title, aliases or membership) or removed/merged
 * away. Identical drafts are left out. Pure read; the order is notes (as in the output, then removals),
 * then circles.
 */
export function previewChanges(notes: NotesStore, target: EditTarget, output: NotesOutput): ProposedChange[] {
  const changes: ProposedChange[] = [];
  if (target.scope !== 'circle') {
    const current = new Map(notes.listNotes(target).map((n) => [n.topic, n]));
    for (const draft of output.notes) {
      const existing = current.get(draft.topic);
      if (existing && existing.title === draft.title && existing.content === draft.content) continue;
      changes.push({
        kind: 'note',
        key: draft.topic,
        title: draft.title,
        change: existing ? 'changed' : 'added',
        ...(existing ? { before: existing.content } : {}),
        after: draft.content,
      });
    }
    for (const topic of output.removed_topics) {
      const existing = current.get(topic);
      if (existing) {
        changes.push({ kind: 'note', key: topic, title: existing.title, change: 'removed', before: existing.content });
      }
    }
  }

  const removedCircle = (slug: string) => {
    const existing = notes.getCircle(slug);
    if (!existing) return;
    changes.push({
      kind: 'circle',
      key: slug,
      title: existing.title,
      change: 'removed',
      before: existing.content,
      membersBefore: existing.members,
      aliasesBefore: existing.aliases,
    });
  };
  for (const draft of output.circles) {
    const existing = notes.getCircle(draft.slug);
    const members: CircleMember[] = draft.members.map((m) => ({
      memberId: canonicalUserId(m.id),
      since: m.since ?? null,
      until: m.until ?? null,
      role: m.role ?? null,
    }));
    const same =
      existing &&
      existing.title === draft.title &&
      existing.content === draft.content &&
      JSON.stringify(existing.aliases) === JSON.stringify(draft.aliases) &&
      sameMembership(existing.members, members);
    if (!same) {
      changes.push({
        kind: 'circle',
        key: draft.slug,
        title: draft.title,
        change: existing ? 'changed' : 'added',
        ...(existing
          ? { before: existing.content, membersBefore: existing.members, aliasesBefore: existing.aliases }
          : {}),
        after: draft.content,
        membersAfter: members,
        aliasesAfter: draft.aliases,
      });
    }
    for (const merged of draft.merged_from) removedCircle(merged);
  }
  for (const slug of output.removed_circles) removedCircle(slug);
  return changes;
}
