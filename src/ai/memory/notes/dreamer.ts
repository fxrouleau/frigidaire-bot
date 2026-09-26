// Memory v2's writers (docs/memory.md): the nightly dream that folds each person's new journal rows into
// their notes (and circles), the group pass after it, and the owner's edits.
//
// - dreamPerson() / dreamGroup(): one MEMORY_DREAM_MODEL call (tag memory_dream, ZDR) over the owner's
//   names, ALL their current notes and circles, the journal rows above their watermark and the cited
//   passages of the entries that matter most (dreamPrompts.ts). The answer goes through parseNotesOutput()
//   (schema.ts, shared by every writer) and is saved with NotesStore.applyNotesOutput(), all or nothing. A
//   refused answer (invalid JSON, a rule broken, a write the store refuses) gets ONE repair round with the
//   errors; then the watermark moves (recordDreamSuccess) only after a successful save. A failure is
//   recorded (recordDreamFailure) and retried the next night. They never throw. An answer drafted from
//   notes that changed while the model was thinking (an owner edit or undo, another writer) is never saved
//   over them: that dream fails without a repair round and the next night dreams from the new version.
// - runNightlyDream(): the people with new rows (most recently active first, capped), then the group when
//   it has new rows, or at least weekly while members' notes keep changing (planGroupDream). The scheduler
//   that calls it once per Eastern day, and the report line, live in dreamSchedule.ts.
// - proposeEdit(): the owner's Edit button (MEMORY_EDIT_MODEL, tag memory_edit): the target's notes plus
//   the instruction, answered as a NotesOutput and dry-run against the store (a savepoint rolled back), so
//   the preview never shows something Confirm would refuse. Nothing is saved: the viewer shows
//   previewChanges() and saves with applyEdit() on Confirm. A draft whose notes changed while the model was
//   thinking (the dream saved meanwhile) is refused, so Confirm can't put back what the dream replaced.
//
// The dream model (Claude Opus by default) only reasons when asked, so the calls send no reasoning field
// and leave generous output room (NOTES_MAX_TOKENS): everything generated is the answer.
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { config } from '../../../config';
import { accountIdsFor, canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import { getOpenRouterClient } from '../../openRouterClient';
import { formatIdentityLines } from '../../promptSections';
import { featureRequestOptions, type UsageFeature } from '../../usage';
import { extractUsage } from '../../usageFetch';
import { parseSqliteUtc } from '../../utils';
import type { Identity, Memory, MemoryStore } from '../memoryStore';
import {
  buildEditPrompt,
  buildGroupDreamPrompt,
  buildPersonDreamPrompt,
  easternDay,
  easternDayOf,
  excerptOnlyProblems,
  type JournalRenderContext,
  MAX_JOURNAL_ROWS_PER_DREAM,
  pickEvidence,
  renderCircles,
  renderJournal,
  renderPassages,
  renderRoster,
  repairPrompt,
} from './dreamPrompts';
import type { Note, NoteChange, NotesStore, PendingDream, WriteNotesResult } from './notesStore';
import { type EvidencePassage, type EvidencePassageOptions, loadEvidencePassages } from './passages';
import {
  type CircleMember,
  clampSummary,
  type NoteOwner,
  type NoteScope,
  type NotesOutput,
  normalizeTopic,
  PROFILE_TOPIC,
  parseNotesOutput,
} from './schema';
import { noteShapeWarnings } from './sections';

export type { NotesOutput } from './schema';
export { parseNotesOutput, validateNotesOutput } from './schema';

const DREAM_FEATURE: UsageFeature = 'memory_dream';
const EDIT_FEATURE: UsageFeature = 'memory_edit';
/**
 * Output room per call. A dream rewrites the profile in full plus the topic notes and circles it changes
 * (a few thousand tokens on a normal night; far more when a first dream builds everything at once). Only
 * the tokens actually generated are billed, and the dream model doesn't reason unless asked, so this is all
 * answer.
 */
const NOTES_MAX_TOKENS = 16_000;
/** A long rewrite takes minutes: well past the shared client's per-attempt default. */
const MODEL_TIMEOUT_MS = 10 * 60_000;
/** Repair rounds after a refused answer (each resends the whole conversation). */
const MAX_REPAIRS = 1;
/** A night stops after this many people failed in a row (the API is down; the rest wait for tomorrow). */
const MAX_FAILURES_IN_A_ROW = 3;
/** Cited passages one dream rereads at most. */
const MAX_PASSAGES_PER_DREAM = 8;
/** The owner's edit instruction (the modal's limit). */
export const MAX_EDIT_INSTRUCTION_CHARS = 4_000;
/** How much of a failure is kept and logged. */
const MAX_ERROR_CHARS = 600;
/**
 * The group pass runs on any night with new server rows; without any, it still runs when its last dream is
 * this many days old and someone's notes (or a circle) changed since: the weekly refresh that keeps the
 * vibe and lore in step with how the members changed.
 */
export const GROUP_REFRESH_DAYS = 7;
/** How much of the members' change history since its last dream the group pass reads. */
const GROUP_CHANGES = { maxVersions: 400, maxPeople: 40, perPerson: 4, summaryChars: 200 } as const;

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
  /**
   * No usable answer (model error, invalid JSON, a refused write): the watermark stays; retried next night.
   * `costUsd`: what the refused answers cost, when any came back.
   */
  | { status: 'failed'; owner: NoteOwner; error: string; costUsd?: number };

/** Context the group pass gets: what changed in the members' notes since its last dream. */
export type GroupDreamContext = {
  /**
   * Each person whose notes changed, by main id and current name, with what changed: the dreams' change
   * summaries (and the owner's edits), dated, oldest first.
   */
  personChanges: { ownerId: string; name: string; changeSummary: string }[];
};

/** Whether tonight's group pass runs, and why (see GROUP_REFRESH_DAYS). */
export type GroupDreamPlan =
  | { run: false }
  | { run: true; why: 'new-rows' | 'weekly-refresh'; context: GroupDreamContext; changedNotes: number };

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

// ---- The model call ----

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type NotesRequestBody = {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  provider: { zdr: true };
};

type ModelAnswer = { text: string; truncated: boolean; costUsd?: number };

/** One ZDR completion, tagged for the usage ledger; its cost read off the response when reported. */
async function askModel(
  client: OpenAI,
  model: string,
  feature: UsageFeature,
  messages: ChatMessage[],
): Promise<ModelAnswer> {
  const body: NotesRequestBody = {
    model,
    max_tokens: NOTES_MAX_TOKENS,
    messages: [...messages],
    provider: { zdr: true },
  };
  // The SDK's types don't know OpenRouter's `provider` object: bridged here, once.
  const response = await client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
    ...featureRequestOptions(feature),
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 1,
  });
  const choice = response.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    truncated: choice?.finish_reason === 'length',
    costUsd: extractUsage(response, feature)?.cost,
  };
}

type Checked<T> =
  | { ok: true; value: T }
  /** `final`: no repair round can fix it (the notes changed meanwhile), so none is asked for. */
  | { ok: false; errors: string[]; final?: boolean };

/**
 * Asks, checks the answer with `check` (parse, validate, and for the dream the save itself), and on a
 * refusal asks once more with the errors (unless the refusal is final). Model and network errors throw (the
 * callers turn them into failures).
 */
async function draftWithRepair<T>(args: {
  client: OpenAI;
  model: string;
  feature: UsageFeature;
  system: string;
  user: string;
  check: (text: string) => Checked<T>;
}): Promise<{ result: Checked<T>; costUsd?: number }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ];
  let costUsd: number | undefined;
  for (let attempt = 0; ; attempt++) {
    const answer = await askModel(args.client, args.model, args.feature, messages);
    if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;
    const result: Checked<T> = answer.truncated
      ? { ok: false, errors: ['the answer was cut off at the length limit'] }
      : answer.text.trim()
        ? args.check(answer.text)
        : { ok: false, errors: ['the answer was empty'] };
    if (result.ok || result.final || attempt >= MAX_REPAIRS) return { result, costUsd };
    messages.push(
      {
        role: 'assistant',
        content: answer.truncated ? '(an answer cut off at the length limit)' : answer.text || '(empty)',
      },
      { role: 'user', content: repairPrompt(result.errors, answer.truncated) },
    );
  }
}

// ---- What a writer was shown ----

/**
 * The versions a writer's prompt was built from, each as `id.version`: the target's notes (a person's or
 * the group's; none for a circle) by topic, and every active circle by slug. Taken with the prompt,
 * compared again right before the save (changedSince).
 */
type NotesBasis = { notes: Map<string, string>; circles: Map<string, string> };

const versionKey = (note: Note) => `${note.id}.${note.version}`;

function notesBasis(notes: NotesStore, target: EditTarget): NotesBasis {
  return {
    notes: new Map(target.scope === 'circle' ? [] : notes.listNotes(target).map((n) => [n.topic, versionKey(n)])),
    circles: new Map(notes.listCircles().map((c) => [c.topic, versionKey(c)])),
  };
}

/**
 * What changed since `basis` that an answer depends on: any of the target's notes (rewritten, undone, added
 * or removed meanwhile: an owner edit or undo, a dream, another process's writer) and the circles the
 * answer writes, merges or removes (plus a circle edit's own circle). Topics, and circles as
 * `circle:<slug>`; empty when none did. The viewer's Confirm applies the same rule (editFingerprint).
 */
function changedSince(notes: NotesStore, target: EditTarget, basis: NotesBasis, output?: NotesOutput): string[] {
  const current = notesBasis(notes, target);
  const changed: string[] = [];
  for (const topic of new Set([...basis.notes.keys(), ...current.notes.keys()])) {
    if (basis.notes.get(topic) !== current.notes.get(topic)) changed.push(topic);
  }
  const slugs = new Set([
    ...(output?.circles.flatMap((c) => [c.slug, ...c.merged_from]) ?? []),
    ...(output?.removed_circles ?? []),
    ...(target.scope === 'circle' ? [target.slug] : []),
  ]);
  for (const slug of [...slugs].sort()) {
    if (basis.circles.get(slug) !== current.circles.get(slug)) changed.push(`circle:${slug}`);
  }
  return changed;
}

// ---- Shared pieces ----

/** A member's current display name by any account id. */
function nameResolver(memory: MemoryStore): (userId: string) => string | undefined {
  return (id) => memory.getIdentityById(canonicalUserId(id))?.display_name ?? memory.getIdentityById(id)?.display_name;
}

/** Ids a writer's output may carry: everyone in SERVER PEOPLE (the input), plus `extra` (the owner, circle members). */
function allowedIdsFrom(identities: Identity[], extra: Iterable<string> = []): string[] {
  return [...new Set([...identities.map((i) => i.discord_user_id), ...extra])];
}

function circleMemberIds(circles: Note[]): string[] {
  return circles.flatMap((c) => c.members.map((m) => m.memberId));
}

/** The oldest rows above the watermark, capped; the rest wait for the next dream. */
function rowsToDream(rows: Memory[]): Memory[] {
  return rows.slice(0, MAX_JOURNAL_ROWS_PER_DREAM);
}

function highestSeq(rows: Memory[]): number {
  return rows.reduce((max, r) => Math.max(max, r.journal_seq ?? 0), 0);
}

function errorText(errors: string[]): string {
  const text = errors.join('; ');
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // The SDK's API errors already read "429 …"; anything else carrying a status gets it prefixed.
    const status = (error as { status?: unknown }).status;
    const prefix = typeof status === 'number' && !error.message.startsWith(String(status)) ? `${status} ` : '';
    return `${prefix}${error.message}`.slice(0, MAX_ERROR_CHARS);
  }
  return String(error).slice(0, MAX_ERROR_CHARS);
}

function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? '' : ` · $${costUsd.toFixed(3)}`;
}

function ownerLabel(owner: NoteOwner, name?: string): string {
  return owner.scope === 'group' ? 'the group' : `${name ?? 'someone'} (${owner.ownerId})`;
}

/** Advisory shape checks on what a dream wrote (the store never refuses a note for its shape). */
function logShapeWarnings(label: string, written: Note[]): void {
  for (const note of written) {
    if (note.scope === 'circle' || !note.active) continue;
    const kind = note.topic === PROFILE_TOPIC && note.scope === 'person' ? 'profile' : 'topic';
    const warnings = noteShapeWarnings(note.content, kind);
    if (warnings.length > 0) logger.info(`dream: ${label}'s "${note.topic}" note: ${warnings.join('; ')}`);
  }
}

type Saved = { output: NotesOutput; saved: Extract<WriteNotesResult, { ok: true }> };

/**
 * The end of a dream: a saved answer moves the watermark (updated, or unchanged when nothing differed); no
 * usable answer records the failure and leaves the watermark alone.
 */
function finishDream(
  deps: DreamDeps,
  owner: NoteOwner,
  label: string,
  watermark: number,
  outcome: { result: Checked<Saved>; costUsd?: number },
): DreamOutcome {
  const cost = outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {};
  if (!outcome.result.ok) {
    const error = errorText(outcome.result.errors);
    deps.notes.recordDreamFailure(owner, error);
    logger.warn(`dream: ${label} failed${formatCost(outcome.costUsd)}: ${error}`);
    return { status: 'failed', owner, error, ...cost };
  }
  const { output, saved } = outcome.result.value;
  deps.notes.recordDreamSuccess(owner, watermark);
  if (saved.written.length === 0 && saved.removed.length === 0) {
    logger.info(`dream: ${label} unchanged (journal through #${watermark})${formatCost(outcome.costUsd)}`);
    return { status: 'unchanged', owner, watermark, ...cost };
  }
  logShapeWarnings(label, saved.written);
  const touched = [
    ...saved.written.map((n) => (n.scope === 'circle' ? `circle:${n.topic}` : n.topic)),
    ...saved.removed.map((n) => `-${n.scope === 'circle' ? `circle:${n.topic}` : n.topic}`),
  ];
  logger.info(
    `dream: ${label} updated [${touched.join(', ')}] (journal through #${watermark})${formatCost(outcome.costUsd)}: ${output.change_summary || '(no summary)'}`,
  );
  return {
    status: 'updated',
    owner,
    written: saved.written,
    removed: saved.removed,
    changeSummary: output.change_summary,
    watermark,
    ...cost,
  };
}

/**
 * A dream's answer, checked and saved: parsed (parseNotesOutput with `parse`), refused for good when the
 * notes it was drafted from changed while the model was thinking (see changedSince: saving it would
 * overwrite the newer version, an owner edit say; no repair round, the next night dreams from the new
 * version), refused for a rewrite of an excerpt-only circle, then saved as dream versions. The comparison
 * and the save run in one IMMEDIATE transaction, so no writer (this process or another: a bootstrap's
 * dream) lands in between.
 */
function checkAndSaveDream(
  deps: DreamDeps,
  owner: NoteOwner,
  text: string,
  check: {
    parse: Parameters<typeof parseNotesOutput>[1];
    basis: NotesBasis;
    excerptOnly: ReadonlySet<string>;
    allowedIds: string[];
  },
): Checked<Saved> {
  const parsed = parseNotesOutput(text, check.parse);
  const save = (): Checked<Saved> => {
    const changed = changedSince(deps.notes, owner, check.basis, parsed.ok ? parsed.value : undefined);
    if (changed.length > 0) {
      return {
        ok: false,
        final: true,
        errors: [
          `the notes changed while dreaming (${changed.join(', ')}): not saved over them; the next night dreams from the new version`,
        ],
      };
    }
    if (!parsed.ok) return parsed;
    const excerpts = excerptOnlyProblems(parsed.value, check.excerptOnly);
    if (excerpts.length > 0) return { ok: false, errors: excerpts };
    const saved = deps.notes.applyNotesOutput(owner, parsed.value, {
      updatedBy: 'dream',
      allowedIds: check.allowedIds,
    });
    return saved.ok ? { ok: true, value: { output: parsed.value, saved } } : { ok: false, errors: saved.errors };
  };
  return deps.memory.sharedDatabase().transaction(save).immediate();
}

/** A dream that threw (a model or network error, a store error): recorded, never rethrown. */
function failDream(deps: DreamDeps, owner: NoteOwner, label: string, error: unknown): DreamOutcome {
  const message = describeError(error);
  try {
    deps.notes.recordDreamFailure(owner, message);
  } catch (recordError) {
    logger.warn(`dream: recording ${label}'s failure failed:`, recordError);
  }
  logger.warn(`dream: ${label} failed: ${message}`);
  return { status: 'failed', owner, error: message };
}

/** The cited passages worth rereading for these rows, as a prompt section ('' when none). */
function passagesFor(deps: DreamDeps, rows: Memory[], ctx: JournalRenderContext): string {
  const picks = pickEvidence(rows, ctx);
  if (picks.length === 0) return '';
  const load = deps.loadPassages ?? loadEvidencePassages;
  let passages: EvidencePassage[] = [];
  try {
    passages = load(
      picks.map((p) => p.messageId),
      { maxPassages: MAX_PASSAGES_PER_DREAM },
    );
  } catch (error) {
    logger.warn('dream: reading evidence passages failed; dreaming without them:', error);
  }
  return renderPassages(passages, picks, ctx.nameOf);
}

// ---- The person dream ----

/**
 * Dreams one person (any account id; their main id is used): their names, ALL their current notes and
 * circles, the journal rows above their watermark (the oldest MAX_JOURNAL_ROWS_PER_DREAM; dated, category,
 * source/speaker, recurrence and seen span, related members, quote) and the cited passages of the entries
 * that matter most (corrections, traits, recurring facts); today's date. One MEMORY_DREAM_MODEL call (plus
 * one repair round when the answer is refused); the answer is parsed with parseNotesOutput({ scope:
 * 'person', requireProfile: true, allowedIds }) and saved with applyNotesOutput(..., { updatedBy: 'dream'
 * }); the watermark moves to the highest journal_seq it read. Never throws: failures come back as 'failed'.
 */
export async function dreamPerson(rawOwnerId: string, deps: DreamDeps): Promise<DreamOutcome> {
  const ownerId = canonicalUserId(rawOwnerId);
  const owner: NoteOwner = { scope: 'person', ownerId };
  let label = ownerLabel(owner);
  try {
    const rows = rowsToDream(deps.notes.newJournal(owner));
    if (rows.length === 0) return { status: 'skipped', owner, reason: 'nothing-new' };

    const memory = deps.memory;
    const nameOf = nameResolver(memory);
    const name = nameOf(ownerId) ?? rows.at(-1)?.subject ?? 'this member';
    label = ownerLabel(owner, name);
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return failDream(deps, owner, label, new Error('OPENROUTER_API_KEY is not set'));

    const now = (deps.now ?? (() => new Date()))();
    const identities = memory.getAllIdentities();
    const accounts = new Set(accountIdsFor(ownerId));
    const person =
      formatIdentityLines(identities.filter((i) => accounts.has(i.discord_user_id)))[0] ??
      `- ${name} (id:${ownerId}): not in SERVER PEOPLE (they may have left)`;
    const circles = deps.notes.circlesOf(ownerId, { includeFormer: true }).map((c) => c.circle);
    const circleView = renderCircles(`CIRCLES ${name} is or was in`, circles, nameOf);
    const ctx: JournalRenderContext = { ownerId, nameOf, canonical: canonicalUserId };
    const prompt = buildPersonDreamPrompt({
      now,
      roster: renderRoster(identities),
      person,
      name,
      notes: deps.notes.listNotes(owner),
      circles: circleView.text,
      journal: renderJournal(rows, ctx),
      passages: passagesFor(deps, rows, ctx),
    });
    const allowedIds = allowedIdsFrom(identities, [...accounts, ...circleMemberIds(circles)]);
    const watermark = highestSeq(rows);
    const basis = notesBasis(deps.notes, owner);

    const outcome = await draftWithRepair<Saved>({
      client,
      model: deps.model ?? config.dream.model,
      feature: DREAM_FEATURE,
      system: prompt.system,
      user: prompt.user,
      check: (text) =>
        checkAndSaveDream(deps, owner, text, {
          parse: { scope: 'person', requireProfile: true, allowedIds },
          basis,
          excerptOnly: circleView.excerptOnly,
          allowedIds,
        }),
    });
    return finishDream(deps, owner, label, watermark, outcome);
  } catch (error) {
    return failDream(deps, owner, label, error);
  }
}

// ---- The group dream ----

/**
 * The group pass after the people: journal rows about the server (no person) plus what changed in the
 * members' notes since its last dream become the group's notes (vibe, lore, running jokes; server-wide only)
 * and any circles that span the group. Same contract as dreamPerson with scope 'group'. Skipped when the
 * group has no new rows, unless `refresh` is set (the weekly refresh: see planGroupDream()).
 */
export async function dreamGroup(
  deps: DreamDeps,
  context: GroupDreamContext,
  opts: { refresh?: boolean } = {},
): Promise<DreamOutcome> {
  const owner: NoteOwner = { scope: 'group' };
  const label = ownerLabel(owner);
  try {
    const rows = rowsToDream(deps.notes.newJournal(owner));
    if (rows.length === 0 && !opts.refresh) return { status: 'skipped', owner, reason: 'nothing-new' };
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return failDream(deps, owner, label, new Error('OPENROUTER_API_KEY is not set'));

    const memory = deps.memory;
    const nameOf = nameResolver(memory);
    const now = (deps.now ?? (() => new Date()))();
    const identities = memory.getAllIdentities();
    const circles = deps.notes.listCircles();
    const circleView = renderCircles('CIRCLES', circles, nameOf);
    const ctx: JournalRenderContext = { nameOf, canonical: canonicalUserId };
    const prompt = buildGroupDreamPrompt({
      now,
      roster: renderRoster(identities),
      notes: deps.notes.listNotes(owner),
      circles: circleView.text,
      personChanges: context.personChanges.map((c) => ({ name: c.name, changeSummary: c.changeSummary })),
      journal: renderJournal(rows, ctx),
      passages: passagesFor(deps, rows, ctx),
    });
    const allowedIds = allowedIdsFrom(identities, circleMemberIds(circles));
    // A refresh reads no rows: the watermark stays where it is.
    const watermark = Math.max(highestSeq(rows), deps.notes.getDreamState(owner).journalWatermark);
    const basis = notesBasis(deps.notes, owner);

    const outcome = await draftWithRepair<Saved>({
      client,
      model: deps.model ?? config.dream.model,
      feature: DREAM_FEATURE,
      system: prompt.system,
      user: prompt.user,
      check: (text) =>
        checkAndSaveDream(deps, owner, text, {
          parse: { scope: 'group', allowedIds },
          basis,
          excerptOnly: circleView.excerptOnly,
          allowedIds,
        }),
    });
    return finishDream(deps, owner, label, watermark, outcome);
  } catch (error) {
    return failDream(deps, owner, label, error);
  }
}

// ---- When the group dreams ----

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A version's "what changed", in words: the dream's summary, the owner's instruction, the undo. */
function changeText(change: NoteChange): string | undefined {
  const reason = change.reason?.trim();
  if (!reason) return undefined;
  const text = change.updatedBy === 'edit' ? `owner edit: ${reason}` : reason;
  return oneLine(text, GROUP_CHANGES.summaryChars);
}

/**
 * The members' note changes, per person (their current name), each dated and said once, oldest first; at
 * most GROUP_CHANGES.perPerson per person (the newest) and GROUP_CHANGES.maxPeople people (the most
 * recently changed). Versions without a reason are left out.
 */
export function summarizePersonChanges(
  changes: NoteChange[],
  nameOf: (userId: string) => string | undefined,
): GroupDreamContext['personChanges'] {
  const people = new Map<string, { items: string[]; texts: Set<string>; latest: number }>();
  changes.forEach((change, index) => {
    if (change.scope !== 'person' || !change.ownerId) return;
    const text = changeText(change);
    if (!text) return;
    const entry = people.get(change.ownerId) ?? { items: [], texts: new Set<string>(), latest: index };
    entry.latest = index;
    if (!entry.texts.has(text)) {
      entry.texts.add(text);
      entry.items.push(`${text} (${easternDayOf(change.updatedAt) ?? change.updatedAt})`);
    }
    people.set(change.ownerId, entry);
  });
  const kept = new Set(
    [...people.entries()]
      .sort((a, b) => b[1].latest - a[1].latest)
      .slice(0, GROUP_CHANGES.maxPeople)
      .map(([ownerId]) => ownerId),
  );
  return [...people.entries()]
    .filter(([ownerId]) => kept.has(ownerId))
    .map(([ownerId, entry]) => ({
      ownerId,
      name: nameOf(ownerId) ?? 'someone',
      changeSummary: entry.items.slice(-GROUP_CHANGES.perPerson).join('; '),
    }));
}

/**
 * Whether the group pass runs tonight: when the server has journal rows above its watermark, or (the weekly
 * refresh) when its last successful dream is GROUP_REFRESH_DAYS or more ago (or never happened) and a
 * person's notes or a circle changed since. Its input then carries every person change since that dream.
 */
export function planGroupDream(deps: Pick<DreamDeps, 'notes' | 'memory'>, now: Date): GroupDreamPlan {
  const owner: NoteOwner = { scope: 'group' };
  const state = deps.notes.getDreamState(owner);
  const changes = deps.notes.changesSince(state.lastDreamAt, { limit: GROUP_CHANGES.maxVersions });
  const context: GroupDreamContext = { personChanges: summarizePersonChanges(changes, nameResolver(deps.memory)) };
  if (deps.notes.newJournal(owner, { limit: 1 }).length > 0) {
    return { run: true, why: 'new-rows', context, changedNotes: changes.length };
  }
  const last = parseSqliteUtc(state.lastDreamAt);
  if (last !== undefined && now.getTime() - last < GROUP_REFRESH_DAYS * 24 * 60 * 60_000) return { run: false };
  if (changes.length === 0) return { run: false };
  return { run: true, why: 'weekly-refresh', context, changedNotes: changes.length };
}

// ---- One night ----

function addCost(total: number | undefined, outcome: DreamOutcome | undefined): number | undefined {
  const cost = outcome && 'costUsd' in outcome ? outcome.costUsd : undefined;
  return cost === undefined ? total : (total ?? 0) + cost;
}

/** The group pass when planGroupDream() says so; 'skipped' otherwise. Never throws. */
async function dreamGroupIfDue(deps: DreamDeps, now: Date): Promise<DreamOutcome> {
  const owner: NoteOwner = { scope: 'group' };
  let plan: GroupDreamPlan;
  try {
    plan = planGroupDream(deps, now);
  } catch (error) {
    return failDream(deps, owner, ownerLabel(owner), error);
  }
  if (!plan.run) return { status: 'skipped', owner, reason: 'nothing-new' };
  if (plan.why === 'weekly-refresh') {
    logger.info(
      `dream: the group has no new rows, but its last dream is ${GROUP_REFRESH_DAYS}+ days old and ${plan.changedNotes} note version(s) changed since: refreshing it.`,
    );
  }
  return dreamGroup(deps, plan.context, { refresh: plan.why === 'weekly-refresh' });
}

/**
 * One night: NotesStore.pendingDreams({ limit: maxPeople ?? MEMORY_DREAM_MAX_PEOPLE_PER_NIGHT }) people,
 * one at a time (most recently active first), then the group when it is due (planGroupDream: new server
 * rows, or the weekly refresh). Stops early after MAX_FAILURES_IN_A_ROW failed people in a row (an outage:
 * everyone left waits for the next night). Never throws. The scheduler
 * that calls it (once per Eastern day) and the report line are dreamSchedule.ts's.
 */
export async function runNightlyDream(deps: DreamDeps & { maxPeople?: number }): Promise<NightlyDreamResult> {
  const now = (deps.now ?? (() => new Date()))();
  const day = easternDay(now);
  const client = deps.client ?? getOpenRouterClient();
  if (!client) {
    logger.warn(`dream: OPENROUTER_API_KEY is not set; no dream tonight (${day}).`);
    return { day, people: [] };
  }
  const withClient: DreamDeps = { ...deps, client };

  let pending: ReturnType<NotesStore['pendingDreams']>;
  try {
    pending = deps.notes.pendingDreams({ limit: deps.maxPeople ?? config.dream.maxPeoplePerNight });
  } catch (error) {
    logger.warn('dream: reading who has new journal rows failed; no dream tonight:', error);
    return { day, people: [] };
  }
  const count = pending.people.length;
  logger.info(
    `dream: night ${day}: ${count} ${count === 1 ? 'person' : 'people'} with new journal rows${pending.group ? ', and the group' : ''}.`,
  );

  const people: DreamOutcome[] = [];
  const run = await dreamPeople(pending.people, withClient, people, 0);
  const group = run.stopped ? undefined : await dreamGroupIfDue(withClient, now);
  return nightResult(day, people, group ? [group] : []);
}

/** A run's result: the outcomes, the last group outcome, and the summed cost. */
function nightResult(day: string, people: DreamOutcome[], groups: DreamOutcome[]): NightlyDreamResult {
  const group = groups.at(-1);
  let costUsd: number | undefined;
  for (const outcome of [...people, ...groups]) costUsd = addCost(costUsd, outcome);
  return { day, people, ...(group ? { group } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/**
 * Dreams these people one at a time, pushing each outcome to `into`; stops once MAX_FAILURES_IN_A_ROW
 * dreams failed in a row (counting on from `failuresInARow`).
 */
async function dreamPeople(
  pending: PendingDream[],
  deps: DreamDeps,
  into: DreamOutcome[],
  failuresInARow: number,
): Promise<{ failuresInARow: number; stopped: boolean }> {
  let failures = failuresInARow;
  for (const entry of pending) {
    if (entry.owner.scope !== 'person') continue;
    const outcome = await dreamPerson(entry.owner.ownerId, deps);
    into.push(outcome);
    failures = outcome.status === 'failed' ? failures + 1 : 0;
    if (failures >= MAX_FAILURES_IN_A_ROW) {
      logger.warn(`dream: ${failures} dreams failed in a row; stopping (the rest wait for the next night).`);
      return { failuresInARow: failures, stopped: true };
    }
  }
  return { failuresInARow: failures, stopped: false };
}

/** Passes runDreamsUntilCaughtUp makes at most (each reads up to MAX_JOURNAL_ROWS_PER_DREAM rows per owner). */
export const MAX_CATCH_UP_PASSES = 100;

/**
 * Dreams until nothing is pending (the built-in bootstrap, whose history leaves people thousands of rows
 * above their watermark, where one night reads MAX_JOURNAL_ROWS_PER_DREAM per person): pass after pass over
 * everyone still pending (no per-night cap), then the group pass the same way, until no owner has rows
 * above their watermark. Someone whose dream fails is not retried in this run (they wait for the nightly
 * dream); MAX_FAILURES_IN_A_ROW failures in a row stop everything, as on a night. Uses only the stores and
 * client in `deps`, and never touches the nightly schedule's once-a-day claim (dreamSchedule.ts).
 * Never throws.
 */
export async function runDreamsUntilCaughtUp(
  deps: DreamDeps & { maxPasses?: number },
): Promise<NightlyDreamResult & { passes: number; caughtUp: boolean }> {
  const now = (deps.now ?? (() => new Date()))();
  const day = easternDay(now);
  const client = deps.client ?? getOpenRouterClient();
  if (!client) {
    logger.warn('dream: OPENROUTER_API_KEY is not set; nothing dreamed.');
    return { day, people: [], passes: 0, caughtUp: false };
  }
  const withClient: DreamDeps = { ...deps, client };
  const maxPasses = Math.max(1, deps.maxPasses ?? MAX_CATCH_UP_PASSES);
  const people: DreamOutcome[] = [];
  const groups: DreamOutcome[] = [];
  // Not retried in this run: a failed dream (the nightly dream retries it), or one that found nothing.
  const settled = new Set<string>();
  let failuresInARow = 0;
  let passes = 0;
  let stopped = false;
  try {
    while (!stopped && passes < maxPasses) {
      const pending = deps.notes
        .pendingDreams()
        .people.filter((p) => p.owner.scope === 'person' && !settled.has(p.owner.ownerId));
      if (pending.length === 0) break;
      passes++;
      logger.info(`dream: catch-up pass ${passes}: ${pending.length} ${pending.length === 1 ? 'person' : 'people'}.`);
      const from = people.length;
      const run = await dreamPeople(pending, withClient, people, failuresInARow);
      failuresInARow = run.failuresInARow;
      stopped = run.stopped;
      for (const outcome of people.slice(from)) {
        const done = outcome.status === 'failed' || outcome.status === 'skipped';
        if (done && outcome.owner.scope === 'person') settled.add(outcome.owner.ownerId);
      }
    }
    while (!stopped && passes < maxPasses) {
      const outcome = await dreamGroupIfDue(withClient, now);
      if (outcome.status === 'skipped') break;
      passes++;
      groups.push(outcome);
      if (outcome.status === 'failed') break;
    }
  } catch (error) {
    logger.warn('dream: catching up failed; the nightly dream picks up the rest:', error);
    stopped = true;
  }
  let caughtUp = false;
  try {
    const left = deps.notes.pendingDreams();
    caughtUp = !stopped && left.people.length === 0 && !left.group;
  } catch {
    caughtUp = false;
  }
  return { ...nightResult(day, people, groups), passes, caughtUp };
}

// ---- Owner edits ----

/** Carries a dry run's result out of the savepoint it rolls back. */
class DryRunRollback extends Error {
  constructor(readonly result: WriteNotesResult) {
    super('memory edit dry run');
  }
}

/**
 * What applyEdit() would return for this output, with nothing written: the store's own checks (circle
 * membership, limits, a person's circles only) run inside a transaction that is always rolled back.
 */
export function dryRunEdit(
  deps: Pick<DreamDeps, 'notes' | 'memory'>,
  target: EditTarget,
  output: NotesOutput,
  allowedIds: string[],
): WriteNotesResult {
  try {
    deps.memory.sharedDatabase().transaction(() => {
      throw new DryRunRollback(deps.notes.applyNotesOutput(target, output, { updatedBy: 'edit', allowedIds }));
    })();
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
  return { ok: false, errors: ['the dry run did not finish'] };
}

type EditView = {
  scope: NoteScope;
  /** What is being edited, for the prompt. */
  what: string;
  /** For the log. */
  label: string;
  target: EditTarget;
  notes?: Note[];
  circles: Note[];
};

/** What an edit of `target` shows the model, or an error when the target doesn't exist. */
function editView(target: EditTarget, deps: DreamDeps): EditView | { error: string } {
  if (target.scope === 'circle') {
    const slug = normalizeTopic(target.slug);
    const circle = slug ? deps.notes.getCircle(slug) : undefined;
    if (!slug || !circle) return { error: `there is no circle "${target.slug}"` };
    return {
      scope: 'circle',
      what: `the circle "${circle.title}" (slug "${circle.topic}"): write exactly this circle, keeping its slug`,
      label: `circle "${slug}"`,
      target: { scope: 'circle', slug },
      circles: [circle],
    };
  }
  if (target.scope === 'group') {
    return {
      scope: 'group',
      what: "your notes on the group as a whole (the server's circles are shown too)",
      label: "the group's notes",
      target,
      notes: deps.notes.listNotes(target),
      circles: deps.notes.listCircles(),
    };
  }
  const ownerId = canonicalUserId(target.ownerId);
  const name = nameResolver(deps.memory)(ownerId) ?? 'this member';
  return {
    scope: 'person',
    what: `your notes on ${name}: their profile, their topic notes and the circles they are or were in`,
    label: `${name}'s notes (${ownerId})`,
    target: { scope: 'person', ownerId },
    notes: deps.notes.listNotes({ scope: 'person', ownerId }),
    circles: deps.notes.circlesOf(ownerId, { includeFormer: true }).map((c) => c.circle),
  };
}

/**
 * Drafts an owner edit with MEMORY_EDIT_MODEL (tag memory_edit): the target's current notes (a person's
 * with their circles; the group's with every circle; one circle) plus the instruction, answered as a
 * NotesOutput for the target's scope ('circle' for a circle edit: exactly that circle). The draft is
 * checked against the store in a rolled-back dry run, with one repair round when refused. Nothing is saved:
 * see previewChanges() and applyEdit(). Never throws: problems come back as { ok: false, error }.
 */
export async function proposeEdit(request: EditRequest, deps: DreamDeps): Promise<EditProposal> {
  try {
    const instruction = request.instruction.trim();
    if (!instruction) return { ok: false, error: 'the instruction is empty' };
    if (instruction.length > MAX_EDIT_INSTRUCTION_CHARS) {
      return {
        ok: false,
        error: `the instruction is longer than ${MAX_EDIT_INSTRUCTION_CHARS.toLocaleString('en-US')} characters`,
      };
    }
    const view = editView(request.target, deps);
    if ('error' in view) return { ok: false, error: view.error };
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return { ok: false, error: 'OPENROUTER_API_KEY is not set' };

    const nameOf = nameResolver(deps.memory);
    const identities = deps.memory.getAllIdentities();
    const circleView = renderCircles(view.scope === 'circle' ? 'THE CIRCLE' : 'CIRCLES', view.circles, nameOf);
    const prompt = buildEditPrompt({
      now: (deps.now ?? (() => new Date()))(),
      roster: renderRoster(identities),
      what: view.what,
      notes: view.notes,
      circles: circleView.text,
      instruction,
    });
    const owned = view.target.scope === 'person' ? accountIdsFor(view.target.ownerId) : [];
    const allowedIds = allowedIdsFrom(identities, [...owned, ...circleMemberIds(view.circles)]);
    const basis = notesBasis(deps.notes, view.target);

    const { result, costUsd } = await draftWithRepair<NotesOutput>({
      client,
      model: deps.model ?? config.dream.editModel,
      feature: EDIT_FEATURE,
      system: prompt.system,
      user: prompt.user,
      check: (text) => {
        const parsed = parseNotesOutput(text, { scope: view.scope, allowedIds });
        // A dream (or another edit) saved while the model drafted: the preview would compare against notes
        // the draft never saw, and Confirm would put the replaced version back. The owner asks again.
        const changed = changedSince(deps.notes, view.target, basis, parsed.ok ? parsed.value : undefined);
        if (changed.length > 0) {
          return {
            ok: false,
            final: true,
            errors: [`the notes changed while drafting (${changed.join(', ')}): ask again`],
          };
        }
        if (!parsed.ok) return parsed;
        const excerpts = excerptOnlyProblems(parsed.value, circleView.excerptOnly);
        if (excerpts.length > 0) return { ok: false, errors: excerpts };
        const dryRun = dryRunEdit(deps, view.target, parsed.value, allowedIds);
        return dryRun.ok ? parsed : { ok: false, errors: dryRun.errors };
      },
    });
    if (!result.ok) {
      const error = errorText(result.errors);
      logger.warn(
        `memory edit: drafting an edit of ${view.label} for ${request.requestedBy} failed${formatCost(costUsd)}: ${error}`,
      );
      return { ok: false, error };
    }
    const changeSummary = result.value.change_summary || clampSummary(instruction);
    logger.info(
      `memory edit: drafted an edit of ${view.label} for ${request.requestedBy}${formatCost(costUsd)}: ${changeSummary}`,
    );
    return { ok: true, target: view.target, output: result.value, allowedIds, changeSummary };
  } catch (error) {
    const message = describeError(error);
    logger.warn(`memory edit: drafting failed: ${message}`);
    return { ok: false, error: message };
  }
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
