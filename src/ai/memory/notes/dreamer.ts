// Memory v2's writers (docs/memory.md): the nightly dream that folds each person's new journal rows into
// their notes (and circles), the group pass after it, and the owner's edits.
//
// - dreamPerson() / dreamGroup(): one MEMORY_DREAM_MODEL call (tag memory_dream, ZDR) over the owner's
//   names, ALL their current notes and circles, the journal rows above their watermark and the cited
//   passages of the entries that matter most (dreamPrompts.ts). The answer goes through parseNotesOutput()
//   (schema.ts, shared by every writer) and is saved with NotesStore.applyNotesOutput(), all or nothing. A
//   note that comes back over its size limit is first shrunk on its own (shrinkOversized: one small call
//   per note, far cheaper and surer than resending the whole prompt). A refused answer (invalid JSON, a
//   rule broken, a write the store refuses, a profile that lost its sections or half its text) gets ONE
//   repair round with the errors (and, for a note still too long, how much to cut); then the watermark
//   moves (recordDreamSuccess) only after a successful save. A failure is recorded (recordDreamFailure) and
//   retried the next night. They never throw. An answer drafted from notes that changed while the model was
//   thinking (an owner edit or undo, another writer) is never saved over them: that dream fails without a
//   repair round and the next night dreams from the new version.
// - runNightlyDream(): the people with new rows (most recently active first, capped), then the group when
//   it has new rows, or at least weekly while members' notes keep changing (planGroupDream). The scheduler
//   that calls it once per Eastern day, and the report line, live in dreamSchedule.ts.
// - proposeEdit(): the owner's Edit button (MEMORY_EDIT_MODEL, tag memory_edit): the target's notes plus
//   the instruction, answered as a NotesOutput and dry-run against the store (a savepoint rolled back), so
//   the preview never shows something Confirm would refuse. Nothing is saved: the viewer shows
//   previewChanges() and saves with applyEdit() on Confirm. A draft whose notes changed while the model was
//   thinking (the dream saved meanwhile) is refused, so Confirm can't put back what the dream replaced.
//
// The dream model (GLM by default) reasons, and reasoning counts toward max_tokens: the calls ask for
// MEMORY_DREAM_REASONING's effort and leave generous output room (NOTES_MAX_TOKENS; only what is generated
// is billed). `off` sends no reasoning field, for a model that only reasons when asked (Claude).
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
import { type Identity, type Memory, type MemoryStore, relatedUserIdsOf } from '../memoryStore';
import { circlesNamedIn } from './context';
import { type DreamLeaseHolder, takeDreamLease } from './dreamLease';
import {
  ARCHIVE_TRACE_SYSTEM,
  buildArchiveTracePrompt,
  buildEditPrompt,
  buildGroupDreamPrompt,
  buildOccasionHistoryPrompt,
  buildPersonDreamPrompt,
  CIRCLES_FULL_BUDGET_CHARS,
  easternDay,
  easternDayOf,
  excerptOnlyProblems,
  type JournalRenderContext,
  MAX_JOURNAL_ROWS_PER_DREAM,
  type Oversize,
  pickEvidence,
  renderCircles,
  renderJournal,
  renderOccasions,
  renderPassages,
  renderRoster,
  repairPrompt,
} from './dreamPrompts';
import {
  type ActivityMonth,
  type ArchiveReason,
  analyzeActivity,
  byOccasionRelevance,
  CIRCLE_DECAY,
  circlePresence,
  defaultOccasionStatus,
  describeRevivals,
  easternDayOfTimestamp,
  easternToday,
  isArchived,
  monthLabel,
  occasionEndDay,
  occasionPhase,
  partialDateStart,
  phaseByDates,
  planLifecycle,
} from './lifecycle';
import {
  detailsOf,
  endCurrentMemberships,
  type Note,
  type NoteChange,
  type NoteDetails,
  type NotesStore,
  type PendingDream,
  type WriteNotesResult,
} from './notesStore';
import { type EvidencePassage, type EvidencePassageOptions, loadEvidencePassages } from './passages';
import {
  type CircleMember,
  clampSummary,
  contentProblems,
  extractJson,
  isSharedScope,
  maxCharsFor,
  NOTE_LIMITS,
  type NoteOwner,
  type NoteScope,
  type NotesOutput,
  normalizeTopic,
  PROFILE_TOPIC,
  parseNotesOutput,
  targetCharsFor,
} from './schema';
import {
  headingKeys,
  noteShapeWarnings,
  occasionShapeWarnings,
  PROFILE_DAMAGE_FLOOR,
  PROFILE_MIN_KEPT_SHARE,
  profileDamage,
  withoutEarlier,
} from './sections';

export type { NotesOutput } from './schema';
export { parseNotesOutput, validateNotesOutput } from './schema';

const DREAM_FEATURE: UsageFeature = 'memory_dream';
const EDIT_FEATURE: UsageFeature = 'memory_edit';
/**
 * Output room per call. A dream rewrites the profile in full plus the topic notes and circles it changes
 * (a few thousand tokens on a normal night; far more when a first dream builds everything at once). Only
 * the tokens actually generated are billed; the room also covers the reasoning MEMORY_DREAM_REASONING asks for.
 */
const NOTES_MAX_TOKENS = 32_000;
/** A long rewrite takes minutes: well past the shared client's per-attempt default. */
const MODEL_TIMEOUT_MS = 10 * 60_000;
/** Repair rounds after a refused answer (each resends the whole conversation). */
const MAX_REPAIRS = 1;
/** Calls per oversized note: the second aims lower when the first still came back over the limit. */
const SHRINK_ATTEMPTS = 2;
/** A shrunk profile keeps this much more than the profile guard's minimum, so the guard never refuses it. */
const SHRINK_GUARD_MARGIN = 100;
/**
 * A night stops after this many dreams in a row failed with a model or network error (the API is down; the
 * rest wait for tomorrow). A refused answer (invalid, cut off, refused by the store) is that person's
 * problem, not an outage: it never counts, so a few people whose dreams keep failing can't stop the night
 * for everyone behind them.
 */
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

/**
 * What an owner edit changes: a person's notes (and their circles and occasions), the group's, one circle
 * or one occasion.
 */
export type EditTarget = NoteOwner | { scope: 'circle'; slug: string } | { scope: 'occasion'; slug: string };

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
      /** Archived circles the dream's rows brought back (shared activity: creditCircleActivity). */
      revived?: Note[];
    }
  /** The model looked and nothing needed rewriting; the watermark still moved. */
  | { status: 'unchanged'; owner: NoteOwner; watermark: number; costUsd?: number; revived?: Note[] }
  /** Nothing above the watermark: no call was made. */
  | { status: 'skipped'; owner: NoteOwner; reason: 'nothing-new' }
  /**
   * No usable answer (model error, invalid JSON, a refused write): the watermark stays; retried next night.
   * `cause`: 'error' when the call itself failed (network, API error, no key, a store error), 'answer' when
   * answers came back but none was usable. `costUsd`: what the refused answers cost, when any came back.
   * `lastDreamAt`: the owner's last successful dream (SQLite UTC), null when they never had one; absent
   * when unknown. `notesUpdatedAt`: without a dream, when their notes were last written (an import).
   */
  | {
      status: 'failed';
      owner: NoteOwner;
      error: string;
      cause: 'error' | 'answer';
      costUsd?: number;
      lastDreamAt?: string | null;
      notesUpdatedAt?: string;
    };

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

/** One step of the nightly lifecycle pass (runLifecycle): an occasion rewritten as history, or a note archived. */
export type LifecycleOutcome =
  | {
      status: 'history';
      /** The occasion's new version. */
      note: Note;
      changeSummary: string;
      costUsd?: number;
    }
  | {
      status: 'archived';
      /** The circle's or occasion's archived version. */
      note: Note;
      why: ArchiveReason;
      costUsd?: number;
    }
  | {
      status: 'failed';
      scope: 'circle' | 'occasion';
      slug: string;
      title: string;
      task: 'history' | 'archive';
      error: string;
      /** As DreamOutcome's: 'error' when a call failed, 'answer' when no answer was usable. */
      cause: 'error' | 'answer';
      costUsd?: number;
    };

/** One night's run: every person dreamed (most recently active first, capped), then the group, then the lifecycle pass. */
export type NightlyDreamResult = {
  /** The Eastern date of the night (YYYY-MM-DD): the once-a-day watermark. */
  day: string;
  people: DreamOutcome[];
  group?: DreamOutcome;
  /** The lifecycle pass: occasions rewritten as history, circles and occasions archived (or failed). */
  lifecycle?: LifecycleOutcome[];
  /** Lifecycle work due but left for the following nights (the per-night caps). */
  lifecycleDeferred?: number;
  /** Live circles fading (slugs, the faintest first: lifecycle.ts CIRCLE_DECAY). */
  fading?: string[];
  /** Archived circles that came back tonight (slugs): shared activity, or a linked occasion. */
  revived?: string[];
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
  /**
   * Aborts the draft's model calls (the viewer's deadline: Discord takes its answer for 15 minutes only).
   * An aborted draft comes back as { ok: false }.
   */
  signal?: AbortSignal;
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
  reasoning?: { effort: 'low' | 'medium' | 'high' };
};

/** The reasoning field MEMORY_DREAM_REASONING asks for (none for `off`). Shared with the bootstrap. */
export function dreamReasoning(): { reasoning?: { effort: 'low' | 'medium' | 'high' } } {
  const effort = config.dream.reasoning;
  return effort === 'off' ? {} : { reasoning: { effort } };
}

type ModelAnswer = { text: string; truncated: boolean; filtered: boolean; costUsd?: number };

/**
 * An error OpenRouter reports inside a 200 answer: an upstream provider's failure (a 429, a 5xx) that the
 * SDK never sees as an HTTP error. Thrown, so the dream records it as a call error (it counts toward the
 * night's outage stop and wastes no repair round on an "empty answer").
 */
class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** One ZDR completion, tagged for the usage ledger; its cost read off the response when reported. */
async function askModel(
  client: OpenAI,
  model: string,
  feature: UsageFeature,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ModelAnswer> {
  const body: NotesRequestBody = {
    model,
    max_tokens: NOTES_MAX_TOKENS,
    messages: [...messages],
    provider: { zdr: true },
    ...dreamReasoning(),
  };
  // The SDK's types don't know OpenRouter's `provider` object: bridged here, once.
  const response = await client.chat.completions.create(body as unknown as ChatCompletionCreateParamsNonStreaming, {
    ...featureRequestOptions(feature),
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 1,
    ...(signal ? { signal } : {}),
  });
  const upstream = (response as { error?: { message?: unknown; code?: unknown } }).error;
  if (upstream) {
    const status = typeof upstream.code === 'number' ? upstream.code : undefined;
    const message = typeof upstream.message === 'string' ? upstream.message : 'unknown upstream error';
    throw new UpstreamError(`${status ?? 'upstream'} ${message}`, status);
  }
  const choice = response.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    truncated: choice?.finish_reason === 'length',
    filtered: choice?.finish_reason === 'content_filter',
    costUsd: extractUsage(response, feature)?.cost,
  };
}

type Checked<T> =
  | { ok: true; value: T }
  /** `final`: no repair round can fix it (the notes changed meanwhile), so none is asked for. */
  | { ok: false; errors: string[]; final?: boolean };

/**
 * Asks, runs `prepare` on the answer (the dream's shrink step), checks it with `check` (parse, validate, and
 * for the dream the save itself), and on a refusal asks once more with the errors and how much to cut from
 * whatever is still over its size limit (unless the refusal is final). Each refusal is logged. Model and
 * network errors throw (the callers turn them into failures).
 */
async function draftWithRepair<T>(args: {
  client: OpenAI;
  model: string;
  feature: UsageFeature;
  system: string;
  user: string;
  check: (text: string) => Checked<T>;
  /** Whose draft, for the log ("dream: Remi (123)", "edit: the group"). */
  label: string;
  /** How the repair prompt sizes an oversized note: a dream aims at the target, an owner edit just under the limit. */
  mode: 'dream' | 'edit';
  /** The scope whose size limits apply to the answer's notes. */
  scope: NoteScope;
  /** Runs on each complete answer before it is checked; never throws. */
  prepare?: (text: string) => Promise<{ text: string; costUsd?: number }>;
  /** Aborts the calls (the SDK then throws, like any model error). */
  signal?: AbortSignal;
}): Promise<{ result: Checked<T>; costUsd?: number }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ];
  let costUsd: number | undefined;
  for (let attempt = 0; ; attempt++) {
    const answer = await askModel(args.client, args.model, args.feature, messages, args.signal);
    if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;
    let text = answer.text;
    if (!answer.truncated && text.trim() && args.prepare) {
      const prepared = await args.prepare(text);
      text = prepared.text;
      if (prepared.costUsd !== undefined) costUsd = (costUsd ?? 0) + prepared.costUsd;
    }
    const result: Checked<T> = answer.filtered
      ? // The provider's moderation, not the model: asking again gets the same stop, so no repair round.
        { ok: false, final: true, errors: ["the provider's content filter stopped the answer"] }
      : answer.truncated
        ? { ok: false, errors: ['the answer was cut off at the length limit'] }
        : text.trim()
          ? args.check(text)
          : { ok: false, errors: ['the answer was empty'] };
    if (result.ok || result.final) return { result, costUsd };
    const last = attempt >= MAX_REPAIRS;
    logger.info(
      `${args.label}: answer ${attempt + 1} refused${last ? '' : ', asking once more'}: ${errorText(result.errors)}`,
    );
    if (last) return { result, costUsd };
    messages.push(
      { role: 'assistant', content: answer.truncated ? '(an answer cut off at the length limit)' : text || '(empty)' },
      {
        role: 'user',
        content: repairPrompt(
          result.errors,
          answer.truncated,
          answer.truncated ? [] : oversizedIn(text, args.scope),
          args.mode,
        ),
      },
    );
  }
}

// ---- Notes that come back too long ----

/** A note or circle of a raw answer over its size limit, and the JSON object it sits in (to rewrite it). */
type OversizedEntry = Oversize & { entry: Record<string, unknown> };

function contentLength(entry: Record<string, unknown>): number | undefined {
  return typeof entry.content === 'string' ? entry.content.replace(/\r\n?/g, '\n').trim().length : undefined;
}

/** The notes and circles of a parsed answer over their size limits (by the validator's own measure). */
function oversizedEntries(answer: unknown, scope: NoteScope): OversizedEntry[] {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
  const fields = answer as Record<string, unknown>;
  const found: OversizedEntry[] = [];
  const objects = (raw: unknown) =>
    (Array.isArray(raw) ? raw : []).filter(
      (e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e),
    );
  if (!isSharedScope(scope)) {
    for (const entry of objects(fields.notes)) {
      const topic = normalizeTopic(entry.topic);
      const length = contentLength(entry);
      if (!topic || length === undefined) continue;
      const max = maxCharsFor(scope, topic);
      if (length > max)
        found.push({ kind: 'note', key: topic, length, max, target: targetCharsFor(scope, topic), entry });
    }
  }
  const shared: [kind: 'circle' | 'occasion', raw: unknown][] = [
    ['circle', fields.circles],
    ['occasion', fields.occasions],
  ];
  for (const [kind, raw] of shared) {
    for (const entry of objects(raw)) {
      const slug = normalizeTopic(entry.slug);
      const length = contentLength(entry);
      const max = maxCharsFor(kind, '');
      if (!slug || length === undefined || length <= max) continue;
      found.push({ kind, key: slug, length, max, target: targetCharsFor(kind, ''), entry });
    }
  }
  return found;
}

/** What in an answer is over its size limit (for the repair prompt). */
function oversizedIn(text: string, scope: NoteScope): Oversize[] {
  const json = extractJson(text);
  return json ? oversizedEntries(json.value, scope).map(({ entry: _entry, ...o }) => o) : [];
}

const SHRINK_SYSTEM = `You shorten one note of a Discord bot's long-term memory about the members of a private server of close friends. Rewrite the note you are given to the size asked for. Keep its markdown shape (the same headings, in the same order), every date and span, and what matters most and what is most recent; cut wording first, then minor details, then the least important footnotes of Earlier. Add nothing, and don't soften how it describes anyone. Answer with the note's markdown only.`;

/** A markdown answer without the code fence a model sometimes wraps it in (and whatever it said around it). */
function unfenced(text: string): string {
  const trimmed = text.trim();
  const fenced = /```[a-z]*\n([\s\S]*?)\n```/i.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * One note rewritten under its limit: up to SHRINK_ATTEMPTS calls, aiming at its target, then lower. A
 * rewrite is used only when it keeps every section the answer's version had (Earlier may shrink away), is
 * at least half the target, and, for a profile, keeps enough of the current one that the profile guard
 * (profileRewriteProblems) won't refuse it. Undefined content when none fit.
 */
async function shrinkNote(
  client: OpenAI,
  model: string,
  item: OversizedEntry,
  current: string | undefined,
): Promise<{ content?: string; costUsd?: number }> {
  const original = String(item.entry.content).trim();
  const sections = [...headingKeys(original)].filter((key) => key !== 'earlier');
  const usable = (text: string): boolean => {
    if (text.length < item.target * 0.5 || text.length > item.max) return false;
    const keys = headingKeys(text);
    if (!sections.every((key) => keys.has(key))) return false;
    if (item.kind !== 'note' || item.key !== PROFILE_TOPIC || current === undefined) return true;
    if (profileDamage(current, text).damaged) return false;
    const kept = withoutEarlier(current).length;
    return (
      kept < PROFILE_DAMAGE_FLOOR || withoutEarlier(text).length >= kept * PROFILE_MIN_KEPT_SHARE + SHRINK_GUARD_MARGIN
    );
  };
  let aim = item.target;
  let costUsd: number | undefined;
  for (let attempt = 0; attempt < SHRINK_ATTEMPTS; attempt++) {
    const answer = await askModel(client, model, DREAM_FEATURE, [
      { role: 'system', content: SHRINK_SYSTEM },
      {
        role: 'user',
        content: `Rewrite this note to at most ${aim.toLocaleString('en-US')} characters (it is ${original.length.toLocaleString('en-US')} now):\n\n${original}`,
      },
    ]);
    if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;
    const text = answer.truncated ? '' : unfenced(answer.text);
    if (usable(text)) return { content: text, costUsd };
    if (text.length > item.max) aim = Math.round(aim * 0.8);
  }
  return { costUsd };
}

/**
 * The dream's shrink step: every note and circle of the answer over its size limit is rewritten on its own
 * under it (shrinkNote), and the answer goes on with the shorter content. Whatever can't be shrunk is left
 * as it was (the check refuses it, and the repair round says how much to cut). Never throws.
 */
async function shrinkOversized(
  text: string,
  scope: NoteScope,
  ctx: {
    client: OpenAI;
    model: string;
    label: string;
    /** The stored content of a note or circle the answer rewrites (the profile guard compares with it). */
    currentOf?: (kind: Oversize['kind'], key: string) => string | undefined;
  },
): Promise<{ text: string; costUsd?: number }> {
  const json = extractJson(text);
  const items = json ? oversizedEntries(json.value, scope) : [];
  if (!json || items.length === 0) return { text };
  let costUsd: number | undefined;
  let changed = false;
  for (const item of items) {
    const what = item.kind === 'note' ? `"${item.key}"` : `${item.kind} "${item.key}"`;
    try {
      const shrunk = await shrinkNote(ctx.client, ctx.model, item, ctx.currentOf?.(item.kind, item.key));
      if (shrunk.costUsd !== undefined) costUsd = (costUsd ?? 0) + shrunk.costUsd;
      if (shrunk.content === undefined) {
        logger.info(
          `${ctx.label}: ${what} came back at ${item.length} characters (limit ${item.max}) and could not be shrunk`,
        );
        continue;
      }
      item.entry.content = shrunk.content;
      changed = true;
      logger.info(
        `${ctx.label}: ${what} came back at ${item.length} characters (limit ${item.max}): shrunk to ${shrunk.content.length}`,
      );
    } catch (error) {
      logger.warn(`${ctx.label}: shrinking ${what} failed:`, error);
    }
  }
  return { text: changed ? JSON.stringify(json.value) : text, ...(costUsd !== undefined ? { costUsd } : {}) };
}

// ---- What a writer was shown ----

/**
 * The versions a writer's prompt was built from, each as `id.version`: the target's notes (a person's or
 * the group's; none for a circle or an occasion) by topic, and every active circle and occasion (archived
 * ones included) by slug. Taken with the prompt, compared again right before the save (changedSince).
 */
type NotesBasis = { notes: Map<string, string>; circles: Map<string, string>; occasions: Map<string, string> };

const versionKey = (note: Note) => `${note.id}.${note.version}`;

/** The person or group an edit target is, or undefined for a circle or an occasion. */
export function ownerTarget(target: EditTarget): NoteOwner | undefined {
  return target.scope === 'person' || target.scope === 'group' ? target : undefined;
}

function notesBasis(notes: NotesStore, target: EditTarget): NotesBasis {
  const owner = ownerTarget(target);
  return {
    notes: new Map(owner ? notes.listNotes(owner).map((n) => [n.topic, versionKey(n)]) : []),
    circles: new Map(notes.listCircles({ includeArchived: true }).map((c) => [c.topic, versionKey(c)])),
    occasions: new Map(notes.listOccasions({ includeArchived: true }).map((o) => [o.topic, versionKey(o)])),
  };
}

/**
 * What changed since `basis` that an answer depends on: any of the target's notes (rewritten, undone, added
 * or removed meanwhile: an owner edit or undo, a dream, another process's writer) and the circles and
 * occasions the answer writes, merges, archives or removes (plus a circle's or occasion's own, for an edit
 * of one). Topics, circles as `circle:<slug>`, occasions as `occasion:<slug>`; empty when none did. The
 * viewer's Confirm applies the same rule (editFingerprint).
 */
function changedSince(notes: NotesStore, target: EditTarget, basis: NotesBasis, output?: NotesOutput): string[] {
  const current = notesBasis(notes, target);
  const changed: string[] = [];
  for (const topic of new Set([...basis.notes.keys(), ...current.notes.keys()])) {
    if (basis.notes.get(topic) !== current.notes.get(topic)) changed.push(topic);
  }
  const { circles, occasions } = touchedSlugs(target, output);
  for (const slug of circles) {
    if (basis.circles.get(slug) !== current.circles.get(slug)) changed.push(`circle:${slug}`);
  }
  for (const slug of occasions) {
    if (basis.occasions.get(slug) !== current.occasions.get(slug)) changed.push(`occasion:${slug}`);
  }
  return changed;
}

/**
 * The circle and occasion slugs a write depends on, sorted: what the output writes, merges, archives or
 * removes, plus the target's own circle or occasion. Shared with the viewer's editFingerprint.
 */
export function touchedSlugs(target: EditTarget, output?: NotesOutput): { circles: string[]; occasions: string[] } {
  const circles = new Set([
    ...(output?.circles.flatMap((c) => [c.slug, ...c.merged_from]) ?? []),
    ...(output?.removed_circles ?? []),
    ...(output?.archived_circles ?? []),
    ...(target.scope === 'circle' ? [target.slug] : []),
  ]);
  const occasions = new Set([
    ...(output?.occasions.map((o) => o.slug) ?? []),
    ...(output?.removed_occasions ?? []),
    ...(target.scope === 'occasion' ? [target.slug] : []),
  ]);
  return { circles: [...circles].sort(), occasions: [...occasions].sort() };
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

/** The member ids of circles (or participant ids of occasions). */
function circleMemberIds(circles: Note[]): string[] {
  return circles.flatMap((c) => c.members.map((m) => m.memberId));
}

/** `profile`, `circle:mtg`, `occasion:ski-trip-2027`: how a written note reads in a log or report line. */
export function noteLabel(note: Pick<Note, 'scope' | 'topic'>): string {
  return isSharedScope(note.scope) ? `${note.scope}:${note.topic}` : note.topic;
}

/** All the text of a dream's journal rows, for finding which circles they name. */
function rowsText(rows: Memory[]): string {
  return rows.map((r) => r.content).join('\n');
}

/** The members (main ids) a journal row is about: its subject and its related members. */
function rowPeople(row: Memory): Set<string> {
  const ids = new Set<string>();
  if (row.subject_user_id) ids.add(canonicalUserId(row.subject_user_id));
  for (const id of relatedUserIdsOf(row)) ids.add(canonicalUserId(id));
  return ids;
}

/** How many of a circle's members (current or former) are among `people`. */
function membersAmong(circle: Pick<Note, 'members'>, people: ReadonlySet<string>): number {
  return new Set(circle.members.map((m) => canonicalUserId(m.memberId)).filter((id) => people.has(id))).size;
}

/**
 * Whether a journal row is shared activity of a circle: it involves at least two of its members (current or
 * former, side accounts folded). A circle is a shared thing: one person doing it alone feeds their own notes,
 * never the circle's activity (the owner: "if I play Yu-Gi-Oh now, the Yu-Gi-Oh circle shouldn't return").
 */
export function isSharedActivity(row: Memory, circle: Pick<Note, 'members'>): boolean {
  return membersAmong(circle, rowPeople(row)) >= 2;
}

/** The Eastern month (`YYYY-MM`) a journal row was last seen in. */
function rowMonth(row: Memory): string | undefined {
  return easternDayOfTimestamp(row.last_seen_at ?? row.updated_at)?.slice(0, 7);
}

/** Whether a journal row is shared activity of a circle that names it (its title, slug or an alias). */
function namesSharedActivity(row: Memory, circle: Note): boolean {
  return isSharedActivity(row, circle) && circlesNamedIn(row.content, [circle]).length > 0;
}

/**
 * Circle activity from a dream's journal rows (lifecycle.ts CIRCLE_DECAY), by the month each row was last
 * seen. Only rows that involve two or more of a circle's members count for it, and:
 * - a row that names circles (title, slug or alias) counts for those, CIRCLE_DECAY.dreamRowWeight each: the
 *   only activity that can make a month real, confirm a return or bring an archived circle back
 *   (NotesStore.recordActivity: provisionally until the return is real; the members behind the rows current
 *   again; postponed when it would pass a limit);
 * - a row that names none ("Remi and Dale moved in together") is ambient: it counts only for the circles that
 *   are present today, at most CIRCLE_DECAY.ambientMonthCap a month, never as real activity and never for a
 *   fading or archived circle.
 * Only the rows filed under the dream's own owner come here (a row about two people sits in both journals and
 * would count twice). Never throws; owner edits never come here.
 */
export function creditCircleActivity(
  notes: NotesStore,
  rows: Memory[],
  circles: Note[],
  label = 'dream',
  today: string = easternToday(new Date()),
): { revived: Note[] } {
  const revived: Note[] = [];
  try {
    const candidates = [
      ...new Map(circles.filter((c) => c.scope === 'circle' && c.active).map((c) => [c.id, c])).values(),
    ];
    const activity = notes.circleActivity();
    const presentIds = new Set(
      candidates
        .filter((c) => !isArchived(c) && circlePresence(c, activity.get(c.id) ?? [], today).state === 'present')
        .map((c) => c.id),
    );
    const credit = new Map<
      number,
      { months: Record<string, number>; ambient: Record<string, number>; rows: number; people: Set<string> }
    >();
    const entry = (id: number) => {
      let found = credit.get(id);
      if (!found) {
        found = { months: {}, ambient: {}, rows: 0, people: new Set() };
        credit.set(id, found);
      }
      return found;
    };
    for (const row of rows) {
      const month = rowMonth(row);
      if (!month) continue;
      const shared = candidates.filter((c) => isSharedActivity(row, c));
      if (shared.length === 0) continue;
      const named = circlesNamedIn(row.content, shared);
      if (named.length > 0) {
        const people = rowPeople(row);
        for (const circle of named) {
          const e = entry(circle.id);
          e.months[month] = (e.months[month] ?? 0) + CIRCLE_DECAY.dreamRowWeight;
          e.rows++;
          for (const m of circle.members) if (people.has(canonicalUserId(m.memberId))) e.people.add(m.memberId);
        }
        continue;
      }
      for (const circle of shared) {
        if (!presentIds.has(circle.id)) continue;
        const e = entry(circle.id);
        e.ambient[month] = (e.ambient[month] ?? 0) + 1;
      }
    }
    for (const [id, credited] of credit) {
      const result = notes.recordActivity(id, credited.months, {
        mode: 'add',
        ambient: credited.ambient,
        revive: credited.rows > 0,
        members: credited.people,
        reason: `${credited.rows} journal ${credited.rows === 1 ? 'row' : 'rows'} naming it, with several of its members`,
      });
      if (result.ok && result.revived) {
        revived.push(result.revived);
        logger.info(
          `${label}: circle "${result.revived.topic}" came back (shared activity in ${result.changed.join(', ')})`,
        );
      }
    }
  } catch (error) {
    logger.warn(`${label}: recording circle activity failed:`, error);
  }
  return { revived };
}

/** What a circle's activity says in a dream's input: presence (when not present), rhythm, revivals. */
function circleMeta(
  circle: Note,
  activity: ReadonlyMap<number, ActivityMonth[]>,
  today: string,
): Record<string, string> {
  if (circle.scope !== 'circle') return {};
  const series = activity.get(circle.id) ?? [];
  const analysis = analyzeActivity(series);
  const meta: Record<string, string> = {};
  if (!isArchived(circle)) {
    const presence = circlePresence(circle, series, today);
    if (presence.state !== 'present') meta.presence = presence.provisional ? 'fading (provisional)' : 'fading';
  }
  if (analysis?.lastReal) meta.last_active = monthLabel(analysis.lastReal);
  if (analysis?.cadence) meta.cadence = analysis.cadence.label;
  const revivals = describeRevivals(analysis, today);
  if (revivals.length > 0) meta.history = revivals.join('; ');
  return meta;
}

/** A circle's activity in words for its archive trace: when it was last really active, its rhythm, revivals. */
function activityHistory(series: ActivityMonth[], today: string): string[] {
  const analysis = analyzeActivity(series);
  if (!analysis) return [];
  return [
    `last really active ${monthLabel(analysis.lastReal)}`,
    ...(analysis.cadence ? [analysis.cadence.label] : []),
    ...describeRevivals(analysis, today),
  ];
}

/** The months (`YYYY-MM`) from one partial date's month to another's, both included. */
function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = from.length >= 7 ? Number(from.slice(5, 7)) : 1;
  const end = to.slice(0, 7).length === 7 ? to.slice(0, 7) : `${to.slice(0, 4)}-12`;
  for (let guard = 0; guard < 60; guard++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > end) break;
    months.push(key);
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year++;
  }
  return months;
}

/**
 * Linked occasions that happened count as their circle's activity (a real return:
 * CIRCLE_DECAY.realReturnWeight per month it covered, up to this month), when at least two of the circle's
 * members took part. An archived circle whose tradition happened again comes back. Idempotent (each month
 * is raised to that weight, never added twice). Returns the circles that came back.
 */
export function creditLinkedOccasions(notes: NotesStore, today: string): Note[] {
  const revived: Note[] = [];
  for (const occasion of notes.listOccasions()) {
    if (!occasion.circle || !occasion.startsOn) continue;
    const phase = occasionPhase(occasion, today);
    if (phase !== 'happening' && phase !== 'past') continue;
    const circle = notes.getCircle(occasion.circle);
    if (!circle) continue;
    const going = new Set(occasion.members.filter((m) => m.until === null).map((m) => canonicalUserId(m.memberId)));
    if (membersAmong(circle, going) < 2) continue;
    const end = occasionEndDay(occasion) ?? partialDateStart(occasion.startsOn);
    const until = end < today ? end : today;
    const months: Record<string, number> = {};
    for (const month of monthsBetween(occasion.startsOn, until)) months[month] = CIRCLE_DECAY.realReturnWeight;
    const result = notes.recordActivity(circle.id, months, {
      mode: 'max',
      revive: true,
      // Its members who took part are current again if it comes back.
      members: going,
      reason: `${occasion.title} happened`,
    });
    if (result.ok && result.revived) {
      revived.push(result.revived);
      logger.info(`dream: circle "${circle.topic}" came back: its occasion "${occasion.topic}" happened`);
    }
  }
  return revived;
}

/**
 * Problems with a dream's answer that brings an archived circle back without a shared comeback: the new
 * journal rows must name it (title, slug or alias) in a row with two or more of its members (a row about its
 * members that names no circle is not its comeback), and the revived circle must list at least two of its
 * members as current. One person's activity goes in their own notes; a different set of people doing the
 * same thing is a new circle.
 */
function revivalProblems(notes: NotesStore, output: NotesOutput, rows: Memory[]): string[] {
  const problems: string[] = [];
  for (const draft of output.circles) {
    const existing = notes.getCircle(draft.slug);
    if (!existing || !isArchived(existing) || output.archived_circles.includes(draft.slug)) continue;
    if (!rows.some((row) => namesSharedActivity(row, existing))) {
      problems.push(
        `circle "${draft.slug}" is archived and no new journal row names it with two or more of its members: leave it out of "circles" (it stays archived). A row about its members that doesn't name it is not its comeback`,
      );
      continue;
    }
    const current = new Set(draft.members.filter((m) => !m.until).map((m) => canonicalUserId(m.id)));
    if (membersAmong(existing, current) >= 2) continue;
    problems.push(
      `circle "${draft.slug}" is archived: bring it back only when at least two of its members are doing it together again, and list them as current ("until": null). One person's activity goes in their own notes (a topic note: "plays GOAT-format Yu-Gi-Oh since Oct 2026"); a different set of people doing the same thing is a new circle (it may mention the old era), not this one`,
    );
  }
  return problems;
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
function logShapeWarnings(label: string, written: Note[], today?: string): void {
  for (const note of written) {
    if (note.scope === 'circle' || !note.active) continue;
    let warnings: string[];
    if (note.scope === 'occasion') {
      const phase = occasionPhase(note, today ?? easternToday(new Date()));
      warnings = occasionShapeWarnings(
        note.content,
        phase === 'archived' ? 'trace' : phase === 'past' || note.status === 'past' ? 'history' : 'plan',
      );
    } else {
      const kind = note.topic === PROFILE_TOPIC && note.scope === 'person' ? 'profile' : 'topic';
      warnings = noteShapeWarnings(note.content, kind);
    }
    if (warnings.length > 0) logger.info(`dream: ${label}'s "${noteLabel(note)}" note: ${warnings.join('; ')}`);
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
    return { status: 'failed', owner, error, cause: 'answer', ...cost, ...lastDream(deps, owner) };
  }
  const { output, saved } = outcome.result.value;
  deps.notes.recordDreamSuccess(owner, watermark);
  if (saved.written.length === 0 && saved.removed.length === 0) {
    logger.info(`dream: ${label} unchanged (journal through #${watermark})${formatCost(outcome.costUsd)}`);
    return { status: 'unchanged', owner, watermark, ...cost };
  }
  logShapeWarnings(label, saved.written);
  const touched = [...saved.written.map(noteLabel), ...saved.removed.map((n) => `-${noteLabel(n)}`)];
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
 * Problems with a dream's rewrite of a circle that leaves out some of its members. "members" is the full
 * membership every time (someone who left gets an "until"), and the output is untrusted: saving it would
 * replace the membership and silently erase the circle (and their dated place in it) from everyone left
 * out. Only the owner removes a member, with an edit. Ids compare as main accounts (a member stored under
 * an account linked since counts as listed). Circles merged away are not checked: the kept one may not
 * have room for everyone.
 */
function droppedMemberProblems(
  notes: NotesStore,
  output: NotesOutput,
  nameOf: (userId: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const dropped = (existing: Note, listedIds: string[]) => {
    const listed = new Set(listedIds.map((id) => canonicalUserId(id)));
    return [...new Set(existing.members.map((m) => canonicalUserId(m.memberId)))].filter((id) => !listed.has(id));
  };
  const who = (ids: string[]) => ids.map((id) => `${nameOf(id) ?? 'a member'} (id:${id})`).join(', ');
  for (const draft of output.circles) {
    const existing = notes.getCircle(draft.slug);
    const left = existing
      ? dropped(
          existing,
          draft.members.map((m) => m.id),
        )
      : [];
    if (left.length === 0) continue;
    problems.push(
      `circle "${draft.slug}" leaves out members it has: keep ${who(left)} in "members" (the full membership every time; give someone who left an "until")`,
    );
  }
  for (const draft of output.occasions) {
    const existing = notes.getOccasion(draft.slug);
    const left = existing
      ? dropped(
          existing,
          draft.participants.map((m) => m.id),
        )
      : [];
    if (left.length === 0) continue;
    problems.push(
      `occasion "${draft.slug}" leaves out participants it has: keep ${who(left)} in "participants" (the full list every time; give someone who bailed an "until")`,
    );
  }
  return problems;
}

const SECTION_NAMES: Record<string, string> = { now: 'Now', traits: 'Traits', circles: 'Circles & people' };

/**
 * Problems with a dream's rewrite of a person's profile that destroys it (sections.ts profileDamage: Now or
 * two core sections lost, or less than half its text outside Earlier left). The store never refuses a note
 * for its shape (owner edits and imports stay free-form): this is the dream's own check, so the repair
 * round can put it right.
 */
function profileRewriteProblems(notes: NotesStore, owner: NoteOwner, output: NotesOutput): string[] {
  if (owner.scope !== 'person') return [];
  const draft = output.notes.find((n) => n.topic === PROFILE_TOPIC);
  const current = notes.getNote(owner, PROFILE_TOPIC);
  if (!draft || !current) return [];
  const damage = profileDamage(current.content, draft.content);
  if (!damage.damaged) return [];
  const problems: string[] = [];
  if (damage.lost.length > 0) {
    const names = damage.lost.map((key) => `"## ${SECTION_NAMES[key] ?? key}"`);
    problems.push(
      `the profile lost its ${names.join(' and ')} section${names.length === 1 ? '' : 's'}: write the whole profile, every section it had`,
    );
  }
  if (damage.shrunk) {
    const before = withoutEarlier(current.content).length;
    const after = withoutEarlier(draft.content).length;
    problems.push(
      `the profile shrank from ${before} to ${after} characters outside Earlier, losing more than half of it: write it in full, keeping everything that still holds`,
    );
  }
  return problems;
}

/**
 * A dream's answer, checked and saved: parsed (parseNotesOutput with `parse`), refused for good when the
 * notes it was drafted from changed while the model was thinking (see changedSince: saving it would
 * overwrite the newer version, an owner edit say; no repair round, the next night dreams from the new
 * version), refused for a rewrite of an excerpt-only circle or one that leaves members out, then saved as
 * dream versions. The comparison and the save run in one IMMEDIATE transaction, so no writer (this process
 * or another: a bootstrap's dream) lands in between.
 */
function checkAndSaveDream(
  deps: DreamDeps,
  owner: NoteOwner,
  text: string,
  check: {
    parse: Parameters<typeof parseNotesOutput>[1];
    basis: NotesBasis;
    excerptOnly: ReadonlySet<string>;
    /** Occasions shown as excerpts or one line (archived): never rewritten. */
    occasionsExcerptOnly?: ReadonlySet<string>;
    /** Archived circles and occasions shown as one line: never removed or merged away either. */
    archivedOnly?: { circles?: ReadonlySet<string>; occasions?: ReadonlySet<string> };
    allowedIds: string[];
    nameOf: (userId: string) => string | undefined;
    /** The journal rows the dream read: an archived circle comes back only when they name it. */
    rows: Memory[];
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
    const problems = [
      ...excerptOnlyProblems(parsed.value, check.excerptOnly, check.occasionsExcerptOnly, check.archivedOnly),
      ...revivalProblems(deps.notes, parsed.value, check.rows),
      ...droppedMemberProblems(deps.notes, parsed.value, check.nameOf),
      ...profileRewriteProblems(deps.notes, owner, parsed.value),
    ];
    if (problems.length > 0) return { ok: false, errors: problems };
    const saved = deps.notes.applyNotesOutput(owner, parsed.value, {
      updatedBy: 'dream',
      allowedIds: check.allowedIds,
    });
    return saved.ok ? { ok: true, value: { output: parsed.value, saved } } : { ok: false, errors: saved.errors };
  };
  return deps.memory.sharedDatabase().transaction(save).immediate();
}

/**
 * When the owner last dreamed successfully, for the report; without a dream yet, when their notes were last
 * written (an import never stamps a dream). {} when it can't be read.
 */
function lastDream(deps: DreamDeps, owner: NoteOwner): { lastDreamAt?: string | null; notesUpdatedAt?: string } {
  try {
    const lastDreamAt = deps.notes.getDreamState(owner).lastDreamAt;
    if (lastDreamAt) return { lastDreamAt };
    const newest = deps.notes
      .listNotes(owner)
      .map((n) => n.updatedAt)
      .sort()
      .at(-1);
    return newest ? { lastDreamAt: null, notesUpdatedAt: newest } : { lastDreamAt: null };
  } catch {
    return {};
  }
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
  return { status: 'failed', owner, error: message, cause: 'error', ...lastDream(deps, owner) };
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
    const rows = rowsToDream(deps.notes.newJournal(owner, { dream: true }));
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
    const shared = personSharedView(deps.notes, ownerId, name, rows, nameOf, now);
    const ctx: JournalRenderContext = { ownerId, nameOf, canonical: canonicalUserId };
    const prompt = buildPersonDreamPrompt({
      now,
      roster: renderRoster(identities),
      person,
      name,
      notes: deps.notes.listNotes(owner),
      circles: shared.circles.text,
      occasions: shared.occasions.text,
      journal: renderJournal(rows, ctx),
      passages: passagesFor(deps, rows, ctx),
    });
    const allowedIds = allowedIdsFrom(identities, [...accounts, ...circleMemberIds(shared.notes)]);
    const watermark = highestSeq(rows);
    const basis = notesBasis(deps.notes, owner);

    const model = deps.model ?? config.dream.model;
    const outcome = await draftWithRepair<Saved>({
      client,
      model,
      feature: DREAM_FEATURE,
      system: prompt.system,
      user: prompt.user,
      label: `dream: ${label}`,
      scope: 'person',
      mode: 'dream',
      prepare: (text) =>
        shrinkOversized(text, 'person', {
          client,
          model,
          label: `dream: ${label}`,
          currentOf: (kind, key) =>
            kind === 'note' && key === PROFILE_TOPIC ? deps.notes.getNote(owner, PROFILE_TOPIC)?.content : undefined,
        }),
      check: (text) =>
        checkAndSaveDream(deps, owner, text, {
          parse: { scope: 'person', requireProfile: true, allowedIds },
          basis,
          excerptOnly: shared.circles.excerptOnly,
          occasionsExcerptOnly: shared.occasions.excerptOnly,
          archivedOnly: { circles: shared.circles.archivedOnly, occasions: shared.occasions.archivedOnly },
          allowedIds,
          nameOf,
          rows,
        }),
    });
    // Rows filed under this person only: a row about two people sits in both journals.
    const own = rows.filter((r) => r.subject_user_id && canonicalUserId(r.subject_user_id) === ownerId);
    return withActivity(
      deps,
      finishDream(deps, owner, label, watermark, outcome),
      own,
      shared.notes.filter((n) => n.scope === 'circle'),
      label,
    );
  } catch (error) {
    return failDream(deps, owner, label, error);
  }
}

type RenderedShared = { text: string; excerptOnly: Set<string>; archivedOnly: Set<string> };

/**
 * Sorts circles for a dream's input: in full, as an excerpt (never rewritten), or as one line (archived).
 * A live circle that is `fullWhenLive` (the person is in it; for the group, any) and present is shown in
 * full; a fading one, or one the person left, only as an excerpt unless the new rows name it. An archived one
 * only as a line, unless a row names it with two or more of its members (it may be back: revivalProblems);
 * one person's rows, or rows about its members that name no circle, never bring it in.
 */
function sortCircles(
  circles: { circle: Note; fullWhenLive: boolean }[],
  rows: Memory[],
  activity: ReadonlyMap<number, ActivityMonth[]>,
  today: string,
): { full: Note[]; excerpts: Note[]; archived: Note[] } {
  const named = new Set(
    circlesNamedIn(
      rowsText(rows),
      circles.map((c) => c.circle),
    ).map((c) => c.id),
  );
  const full: Note[] = [];
  const excerpts: Note[] = [];
  const archived: Note[] = [];
  for (const { circle, fullWhenLive } of circles) {
    if (isArchived(circle)) {
      (rows.some((row) => namesSharedActivity(row, circle)) ? full : archived).push(circle);
      continue;
    }
    const present = circlePresence(circle, activity.get(circle.id) ?? [], today).state === 'present';
    if ((fullWhenLive && present) || named.has(circle.id)) full.push(circle);
    else excerpts.push(circle);
  }
  return { full, excerpts, archived };
}

/**
 * The circles and occasions a person's dream shows: the circles they are in and that are present, in full;
 * fading ones and the ones they left as excerpts (unless a new row names them), archived ones as one line
 * each (unless a new row names them with two of their members: sortCircles), each with its rhythm and revivals; their occasions in full, the most relevant
 * first, archived ones one line each. Also every note shown (for the ids the answer may carry). This is most
 * of what a dream reads that isn't the person's own: a long-time member was in dozens of circles.
 */
function personSharedView(
  notes: NotesStore,
  ownerId: string,
  name: string,
  rows: Memory[],
  nameOf: (userId: string) => string | undefined,
  now: Date,
): { circles: RenderedShared; occasions: RenderedShared; notes: Note[] } {
  const today = easternToday(now);
  const activity = notes.circleActivity();
  const memberships = notes.circlesOf(ownerId, { includeFormer: true, includeArchived: true });
  const { full, excerpts, archived } = sortCircles(
    memberships.map((m) => ({ circle: m.circle, fullWhenLive: m.membership.until === null })),
    rows,
    activity,
    today,
  );
  const occasions = notes
    .occasionsOf(ownerId, { includeFormer: true, includeArchived: true })
    .map((o) => o.occasion)
    .sort(byOccasionRelevance(today));
  return {
    circles: renderCircles(
      `CIRCLES ${name} is or was in`,
      full,
      nameOf,
      CIRCLES_FULL_BUDGET_CHARS,
      {},
      {
        excerpts,
        archived,
        meta: (c) => circleMeta(c, activity, today),
      },
    ),
    occasions: renderOccasions(
      `OCCASIONS ${name} is or was part of`,
      occasions.filter((o) => !isArchived(o)),
      nameOf,
      today,
      { archived: occasions.filter(isArchived) },
    ),
    notes: [...full, ...excerpts, ...archived, ...occasions],
  };
}

/**
 * The circles and occasions the group pass shows: every present circle in full (within the budget), fading
 * ones as excerpts, archived ones one line each (unless a new row names them: sortCircles), each with
 * its rhythm and revivals; every occasion in full, the most relevant first, archived ones one line each.
 */
function groupSharedView(
  notes: NotesStore,
  rows: Memory[],
  nameOf: (userId: string) => string | undefined,
  now: Date,
): { circles: RenderedShared; occasions: RenderedShared; notes: Note[] } {
  const today = easternToday(now);
  const activity = notes.circleActivity();
  const all = notes.listCircles({ includeArchived: true });
  const { full, excerpts, archived } = sortCircles(
    all.map((circle) => ({ circle, fullWhenLive: true })),
    rows,
    activity,
    today,
  );
  const occasions = notes.listOccasions({ includeArchived: true }).sort(byOccasionRelevance(today));
  return {
    circles: renderCircles(
      'CIRCLES',
      full,
      nameOf,
      CIRCLES_FULL_BUDGET_CHARS,
      {},
      {
        excerpts,
        archived,
        meta: (c) => circleMeta(c, activity, today),
      },
    ),
    occasions: renderOccasions(
      'OCCASIONS',
      occasions.filter((o) => !isArchived(o)),
      nameOf,
      today,
      { archived: occasions.filter(isArchived) },
    ),
    notes: [...all, ...occasions],
  };
}

/**
 * After a saved dream: its own rows' shared activity counts for the circles it saw or wrote
 * (creditCircleActivity); the circles that came back ride on the outcome.
 */
function withActivity(
  deps: DreamDeps,
  outcome: DreamOutcome,
  rows: Memory[],
  circles: Note[],
  label: string,
): DreamOutcome {
  if (outcome.status !== 'updated' && outcome.status !== 'unchanged') return outcome;
  const written = outcome.status === 'updated' ? outcome.written.filter((n) => n.scope === 'circle' && n.active) : [];
  // A circle this very answer archived stays archived: the dream judged it over.
  const justArchived = new Set(written.filter(isArchived).map((n) => n.id));
  const candidates = [...circles, ...written]
    .filter((c) => !justArchived.has(c.id))
    .map((c) => deps.notes.getNoteById(c.id) ?? c);
  const today = easternToday((deps.now ?? (() => new Date()))());
  const { revived } = creditCircleActivity(deps.notes, rows, candidates, `dream: ${label}`, today);
  return revived.length > 0 ? { ...outcome, revived } : outcome;
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
    const rows = rowsToDream(deps.notes.newJournal(owner, { dream: true }));
    if (rows.length === 0 && !opts.refresh) return { status: 'skipped', owner, reason: 'nothing-new' };
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return failDream(deps, owner, label, new Error('OPENROUTER_API_KEY is not set'));

    const memory = deps.memory;
    const nameOf = nameResolver(memory);
    const now = (deps.now ?? (() => new Date()))();
    const identities = memory.getAllIdentities();
    const shared = groupSharedView(deps.notes, rows, nameOf, now);
    const ctx: JournalRenderContext = { nameOf, canonical: canonicalUserId };
    const prompt = buildGroupDreamPrompt({
      now,
      roster: renderRoster(identities),
      notes: deps.notes.listNotes(owner),
      circles: shared.circles.text,
      occasions: shared.occasions.text,
      personChanges: context.personChanges.map((c) => ({ name: c.name, changeSummary: c.changeSummary })),
      journal: renderJournal(rows, ctx),
      passages: passagesFor(deps, rows, ctx),
    });
    const allowedIds = allowedIdsFrom(identities, circleMemberIds(shared.notes));
    // A refresh reads no rows: the watermark stays where it is.
    const watermark = Math.max(highestSeq(rows), deps.notes.getDreamState(owner).journalWatermark);
    const basis = notesBasis(deps.notes, owner);

    const model = deps.model ?? config.dream.model;
    const outcome = await draftWithRepair<Saved>({
      client,
      model,
      feature: DREAM_FEATURE,
      system: prompt.system,
      user: prompt.user,
      label: `dream: ${label}`,
      scope: 'group',
      mode: 'dream',
      prepare: (text) => shrinkOversized(text, 'group', { client, model, label: `dream: ${label}` }),
      check: (text) =>
        checkAndSaveDream(deps, owner, text, {
          parse: { scope: 'group', allowedIds },
          basis,
          excerptOnly: shared.circles.excerptOnly,
          occasionsExcerptOnly: shared.occasions.excerptOnly,
          archivedOnly: { circles: shared.circles.archivedOnly, occasions: shared.occasions.archivedOnly },
          allowedIds,
          nameOf,
          rows,
        }),
    });
    return withActivity(
      deps,
      finishDream(deps, owner, label, watermark, outcome),
      rows.filter((r) => !r.subject_user_id),
      shared.notes.filter((n) => n.scope === 'circle'),
      label,
    );
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
  if (deps.notes.newJournal(owner, { limit: 1, dream: true }).length > 0) {
    return { run: true, why: 'new-rows', context, changedNotes: changes.length };
  }
  const last = parseSqliteUtc(state.lastDreamAt);
  if (last !== undefined && now.getTime() - last < GROUP_REFRESH_DAYS * 24 * 60 * 60_000) return { run: false };
  if (changes.length === 0) return { run: false };
  return { run: true, why: 'weekly-refresh', context, changedNotes: changes.length };
}

// ---- The lifecycle pass ----

/** Calls one archive makes at most: the second aims lower when the first trace came back too long. */
const COMPACT_ATTEMPTS = 2;

const ARCHIVE_REASONS: Record<ArchiveReason, string> = {
  ended: 'it ended months ago',
  cancelled: 'it was called off',
  dormant: 'it faded out, nothing shared in a long time',
  compact: 'compacted to a trace',
  requested: "the owner's archive command",
};

/**
 * A circle's or occasion's short historical trace (ARCHIVE_TRACE_SYSTEM): up to COMPACT_ATTEMPTS small
 * calls (tag memory_dream), aiming at NOTE_LIMITS.archivedTargetChars, then a fifth lower. A trace is used
 * only when it is within NOTE_LIMITS.archivedMaxChars and passes the note rules (markdown only, no ids but
 * its members'). `content` is undefined (with the last problem) when none did.
 */
async function compactNote(
  client: OpenAI,
  model: string,
  args: {
    note: Note;
    why: ArchiveReason;
    nameOf: (id: string) => string | undefined;
    today: string;
    journal?: string;
    history?: string[];
  },
): Promise<{ content?: string; problem?: string; costUsd?: number }> {
  const { note } = args;
  const allowed = new Set(note.members.map((m) => m.memberId));
  let aim: number = NOTE_LIMITS.archivedTargetChars;
  let costUsd: number | undefined;
  let problem = 'no usable trace came back';
  for (let attempt = 0; attempt < COMPACT_ATTEMPTS; attempt++) {
    const answer = await askModel(client, model, DREAM_FEATURE, [
      { role: 'system', content: ARCHIVE_TRACE_SYSTEM },
      { role: 'user', content: buildArchiveTracePrompt({ ...args, aim }) },
    ]);
    if (answer.costUsd !== undefined) costUsd = (costUsd ?? 0) + answer.costUsd;
    if (answer.truncated) {
      problem = 'the trace was cut off at the length limit';
      continue;
    }
    const checked = contentProblems(unfenced(answer.text), 'the trace', NOTE_LIMITS.archivedMaxChars, allowed);
    if (checked.content && checked.errors.length === 0) return { content: checked.content, costUsd };
    problem = checked.errors[0] ?? 'the trace was empty';
    if ((checked.content?.length ?? 0) > NOTE_LIMITS.archivedMaxChars) aim = Math.round(aim * 0.8);
  }
  return { problem, costUsd };
}

function lifecycleFailure(
  note: Note,
  task: 'history' | 'archive',
  error: string,
  cause: 'error' | 'answer',
  costUsd?: number,
): Extract<LifecycleOutcome, { status: 'failed' }> {
  return {
    status: 'failed',
    scope: note.scope === 'occasion' ? 'occasion' : 'circle',
    slug: note.topic,
    title: note.title,
    task,
    error,
    cause,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Archives a circle or an occasion as a short historical trace: one small call (compactNote; an occasion
 * never written as history also gets its journal window), then NotesStore.archiveNote (status 'archived', a
 * circle's current memberships ended, refused when the note changed meanwhile). The nightly lifecycle pass
 * and the owner's `memory archive` command (bootstrap CLI) both archive through here. Never throws.
 */
export async function archiveShared(
  note: Note,
  why: ArchiveReason,
  deps: DreamDeps,
  now: Date = (deps.now ?? (() => new Date()))(),
): Promise<LifecycleOutcome> {
  const label = `${note.scope} "${note.topic}"`;
  try {
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return lifecycleFailure(note, 'archive', 'OPENROUTER_API_KEY is not set', 'error');
    const nameOf = nameResolver(deps.memory);
    const today = easternToday(now);
    const neverHistory = note.scope === 'occasion' && note.status !== 'past' && !isArchived(note);
    const rows = neverHistory ? deps.notes.occasionJournal(note) : [];
    const journal = rows.length > 0 ? renderJournal(rows, { nameOf, canonical: canonicalUserId }) : undefined;
    const compacted = await compactNote(client, deps.model ?? config.dream.model, {
      note,
      why,
      nameOf,
      today,
      journal,
      history: note.scope === 'circle' ? activityHistory(deps.notes.activityOf(note.id), today) : [],
    });
    if (!compacted.content) {
      const error = `couldn't compact it to a trace: ${compacted.problem ?? 'no answer'}`;
      logger.warn(`dream: archiving ${label} failed${formatCost(compacted.costUsd)}: ${error}`);
      return lifecycleFailure(note, 'archive', error, 'answer', compacted.costUsd);
    }
    const saved = deps.notes.archiveNote(note.id, {
      content: compacted.content,
      updatedBy: 'dream',
      reason: `archived as a trace: ${ARCHIVE_REASONS[why]}`,
      expectVersion: note.version,
    });
    if (!saved.ok) {
      const error = errorText(saved.errors);
      logger.warn(`dream: archiving ${label} failed${formatCost(compacted.costUsd)}: ${error}`);
      return lifecycleFailure(note, 'archive', error, 'answer', compacted.costUsd);
    }
    const archived = saved.written[0] ?? deps.notes.getNoteById(note.id) ?? note;
    logger.info(
      `dream: archived ${label} (${ARCHIVE_REASONS[why]}): ${note.content.length} → ${archived.content.length} characters${formatCost(compacted.costUsd)}`,
    );
    return {
      status: 'archived',
      note: archived,
      why,
      ...(compacted.costUsd !== undefined ? { costUsd: compacted.costUsd } : {}),
    };
  } catch (error) {
    const message = describeError(error);
    logger.warn(`dream: archiving ${label} failed: ${message}`);
    return lifecycleFailure(note, 'archive', message, 'error');
  }
}

/**
 * The occasion pass's answer, checked and saved in one IMMEDIATE transaction: refused for good when the
 * occasion changed while the model was thinking (an owner edit), refused (repair round) when it writes
 * another occasion, drops a participant, or stays "planned" although its dates are behind; saved as a
 * dream version of that occasion. A missing status reads as "past".
 */
function saveOccasionHistory(
  deps: DreamDeps,
  occasion: Note,
  text: string,
  check: { allowedIds: string[]; nameOf: (userId: string) => string | undefined; today: string },
): Checked<{ note: Note; changeSummary: string }> {
  const parsed = parseNotesOutput(text, { scope: 'occasion', allowedIds: check.allowedIds });
  const save = (): Checked<{ note: Note; changeSummary: string }> => {
    const current = deps.notes.getOccasion(occasion.topic);
    if (!current || current.id !== occasion.id || current.version !== occasion.version) {
      return {
        ok: false,
        final: true,
        errors: [`the occasion changed while dreaming: not saved over it; the next night reads the new version`],
      };
    }
    if (!parsed.ok) return parsed;
    const draft = parsed.value.occasions[0];
    if (draft.slug !== occasion.topic) {
      return { ok: false, errors: [`write the occasion "${occasion.topic}" itself, keeping its slug`] };
    }
    const over = phaseByDates(draft.starts_on, draft.ends_on, check.today) === 'past';
    if (draft.status === 'archived') {
      return {
        ok: false,
        errors: ['"status" is "past" (or "cancelled", or "planned" with new dates), not "archived"'],
      };
    }
    if (draft.status === null) draft.status = over ? 'past' : 'planned';
    if ((draft.status === 'planned' || draft.status === 'happening') && over) {
      return {
        ok: false,
        errors: [
          `it is over by its dates (${draft.ends_on ?? draft.starts_on}): "status" is "past" (or "cancelled" if it never happened), or give its new dates if it was moved`,
        ],
      };
    }
    const problems = droppedMemberProblems(deps.notes, parsed.value, check.nameOf);
    if (problems.length > 0) return { ok: false, errors: problems };
    const saved = deps.notes.applyNotesOutput({ scope: 'occasion', slug: occasion.topic }, parsed.value, {
      updatedBy: 'dream',
      allowedIds: check.allowedIds,
    });
    if (!saved.ok) return { ok: false, errors: saved.errors };
    return {
      ok: true,
      value: {
        note: saved.written[0] ?? deps.notes.getOccasion(occasion.topic) ?? current,
        changeSummary: parsed.value.change_summary,
      },
    };
  };
  return deps.memory.sharedDatabase().transaction(save).immediate();
}

/**
 * The occasion pass for one occasion that is over by its dates and was never written as history: one
 * MEMORY_DREAM_MODEL call (tag memory_dream, the dream's repair round and shrink step) over the occasion,
 * the journal rows of its participants around its dates and those that name it (NotesStore.occasionJournal)
 * and their cited passages, answered as the occasion rewritten as history (status "past"; "cancelled" when
 * it never happened; new dates when it moved). Never throws.
 */
export async function dreamOccasionHistory(
  occasion: Note,
  deps: DreamDeps,
  now: Date = (deps.now ?? (() => new Date()))(),
): Promise<LifecycleOutcome> {
  const label = `occasion "${occasion.topic}"`;
  try {
    const client = deps.client ?? getOpenRouterClient();
    if (!client) return lifecycleFailure(occasion, 'history', 'OPENROUTER_API_KEY is not set', 'error');
    const memory = deps.memory;
    const nameOf = nameResolver(memory);
    const identities = memory.getAllIdentities();
    const today = easternToday(now);
    const rows = deps.notes.occasionJournal(occasion);
    const ctx: JournalRenderContext = { nameOf, canonical: canonicalUserId };
    const prompt = buildOccasionHistoryPrompt({
      now,
      today,
      roster: renderRoster(identities),
      occasion: renderOccasions('THE OCCASION', [occasion], nameOf, today, { budget: Number.POSITIVE_INFINITY }).text,
      journal: renderJournal(rows, ctx),
      passages: passagesFor(deps, rows, ctx),
    });
    const allowedIds = allowedIdsFrom(identities, circleMemberIds([occasion]));
    const model = deps.model ?? config.dream.model;
    const outcome = await draftWithRepair<{ note: Note; changeSummary: string }>({
      client,
      model,
      feature: DREAM_FEATURE,
      system: prompt.system,
      user: prompt.user,
      label: `dream: ${label}`,
      scope: 'occasion',
      mode: 'dream',
      prepare: (text) => shrinkOversized(text, 'occasion', { client, model, label: `dream: ${label}` }),
      check: (text) => saveOccasionHistory(deps, occasion, text, { allowedIds, nameOf, today }),
    });
    const cost = outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {};
    if (!outcome.result.ok) {
      const error = errorText(outcome.result.errors);
      logger.warn(`dream: rewriting ${label} as history failed${formatCost(outcome.costUsd)}: ${error}`);
      return lifecycleFailure(occasion, 'history', error, 'answer', outcome.costUsd);
    }
    const { note, changeSummary } = outcome.result.value;
    logShapeWarnings(label, [note], today);
    logger.info(
      `dream: rewrote ${label} as history (${note.status}, journal ${rows.length} rows)${formatCost(outcome.costUsd)}: ${changeSummary || '(no summary)'}`,
    );
    return { status: 'history', note, changeSummary, ...cost };
  } catch (error) {
    const message = describeError(error);
    logger.warn(`dream: rewriting ${label} as history failed: ${message}`);
    return lifecycleFailure(occasion, 'history', message, 'error');
  }
}

/**
 * bot_state key of the lifecycle steps whose last try failed on the answer: `{"<note id>": <its version>}`.
 * Those go after the untried ones (planLifecycle `failed`) until the note gets a new version or a step on it
 * succeeds, so a few notes the model can't handle never starve the rest.
 */
export const LIFECYCLE_FAILED_KEY = 'lifecycle:failed';

function readLifecycleFailures(deps: DreamDeps): Map<number, number> {
  try {
    const raw = JSON.parse(deps.memory.getState(LIFECYCLE_FAILED_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map();
    return new Map(
      Object.entries(raw as Record<string, unknown>)
        .filter(([id, version]) => Number.isInteger(Number(id)) && typeof version === 'number')
        .map(([id, version]) => [Number(id), version as number]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The nightly lifecycle pass (lifecycle.ts planLifecycle): occasions over by their dates are rewritten as
 * history (dreamOccasionHistory), then past and cancelled occasions due, archived notes still too long and
 * circles that faded out (CIRCLE_DECAY) are archived (archiveShared), each capped per night
 * (LIFECYCLE_PER_NIGHT; the rest wait). Notes whose last step failed on the answer go last
 * (LIFECYCLE_FAILED_KEY). Stops after MAX_FAILURES_IN_A_ROW failed calls in a row (an outage). Never throws.
 */
export async function runLifecycle(
  deps: DreamDeps,
  now: Date = (deps.now ?? (() => new Date()))(),
): Promise<LifecycleRun> {
  const today = easternToday(now);
  let plan: ReturnType<typeof planLifecycle>;
  let revived: Note[] = [];
  const failedBefore = readLifecycleFailures(deps);
  let versions = new Map<number, number>();
  try {
    revived = creditLinkedOccasions(deps.notes, today);
    const occasions = deps.notes.listOccasions({ includeArchived: true });
    const circles = deps.notes.listCircles({ includeArchived: true });
    versions = new Map([...occasions, ...circles].map((n) => [n.id, n.version]));
    plan = planLifecycle({
      occasions,
      circles,
      today,
      activity: deps.notes.circleActivity(),
      failed: new Set([...failedBefore].filter(([id, version]) => versions.get(id) === version).map(([id]) => id)),
    });
  } catch (error) {
    logger.warn('dream: planning the lifecycle pass failed; skipped tonight:', error);
    return { outcomes: [], deferred: 0, fading: [], revived };
  }
  const fading = plan.fading.map((c) => c.topic);
  if (plan.history.length === 0 && plan.archive.length === 0) {
    return { outcomes: [], deferred: plan.deferred, fading, revived };
  }
  logger.info(
    `dream: lifecycle pass: ${plan.history.length} occasion(s) to rewrite as history, ${plan.archive.length} note(s) to archive${plan.deferred > 0 ? `, ${plan.deferred} left for the next nights` : ''}.`,
  );
  const outcomes: LifecycleOutcome[] = [];
  let failures = 0;
  const steps: { note: Note; run: () => Promise<LifecycleOutcome> }[] = [
    ...plan.history.map((occasion) => ({ note: occasion, run: () => dreamOccasionHistory(occasion, deps, now) })),
    ...plan.archive.map((task) => ({ note: task.note, run: () => archiveShared(task.note, task.why, deps, now) })),
  ];
  // Only failures on notes that still exist at the version they failed at are kept.
  const failedAfter = new Map([...failedBefore].filter(([id, version]) => versions.get(id) === version));
  for (const step of steps) {
    const outcome = await step.run();
    outcomes.push(outcome);
    if (outcome.status === 'failed' && outcome.cause === 'answer') failedAfter.set(step.note.id, step.note.version);
    else if (outcome.status !== 'failed') failedAfter.delete(step.note.id);
    failures = outcome.status === 'failed' && outcome.cause === 'error' ? failures + 1 : 0;
    if (failures >= MAX_FAILURES_IN_A_ROW) {
      logger.warn(`dream: ${failures} lifecycle calls failed in a row; stopping (the rest wait for the next night).`);
      break;
    }
  }
  try {
    deps.memory.setState(LIFECYCLE_FAILED_KEY, JSON.stringify(Object.fromEntries(failedAfter)));
  } catch (error) {
    logger.warn('dream: recording the lifecycle failures failed:', error);
  }
  return { outcomes, deferred: plan.deferred, fading, revived };
}

/** What the lifecycle pass did (runLifecycle). */
export type LifecycleRun = {
  outcomes: LifecycleOutcome[];
  /** Due but left for the following nights. */
  deferred: number;
  /** Live circles fading (slugs, the faintest first). */
  fading: string[];
  /** Archived circles their linked occasions brought back. */
  revived: Note[];
};

// ---- One night ----

function addCost(total: number | undefined, outcome: DreamOutcome | LifecycleOutcome | undefined): number | undefined {
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
 * everyone left waits for the next night). Never throws. The scheduler that calls it (once per Eastern
 * day, holding the dream lease: dreamLease.ts) and the report line are dreamSchedule.ts's.
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
  // The lifecycle pass last: tonight's dreams may have archived circles it compacts, or rewritten an
  // occasion as history already.
  const lifecycle = run.stopped ? undefined : await runLifecycle(withClient, now);
  return nightResult(day, people, group ? [group] : [], lifecycle);
}

/** A run's result: the outcomes, the last group outcome, the lifecycle pass, and the summed cost. */
function nightResult(
  day: string,
  people: DreamOutcome[],
  groups: DreamOutcome[],
  lifecycle?: LifecycleRun,
): NightlyDreamResult {
  const group = groups.at(-1);
  let costUsd: number | undefined;
  for (const outcome of [...people, ...groups, ...(lifecycle?.outcomes ?? [])]) costUsd = addCost(costUsd, outcome);
  // Circles that came back tonight: through a dream's shared rows, or a linked occasion that happened.
  const revived = [
    ...[...people, ...groups].flatMap((o) => ('revived' in o && o.revived ? o.revived : [])),
    ...(lifecycle?.revived ?? []),
  ].map((c) => c.topic);
  return {
    day,
    people,
    ...(group ? { group } : {}),
    ...(lifecycle && lifecycle.outcomes.length > 0 ? { lifecycle: lifecycle.outcomes } : {}),
    ...(lifecycle && lifecycle.deferred > 0 ? { lifecycleDeferred: lifecycle.deferred } : {}),
    ...(lifecycle && lifecycle.fading.length > 0 ? { fading: lifecycle.fading } : {}),
    ...(revived.length > 0 ? { revived: [...new Set(revived)] } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Dreams these people one at a time, pushing each outcome to `into`; stops once MAX_FAILURES_IN_A_ROW
 * calls failed in a row (counting on from `failuresInARow`; refused answers don't count).
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
    // Only a failed call counts toward the outage stop; any answer (usable or not) means the API is up.
    failures = outcome.status === 'failed' && outcome.cause === 'error' ? failures + 1 : 0;
    if (failures >= MAX_FAILURES_IN_A_ROW) {
      logger.warn(`dream: ${failures} dreams failed in a row; stopping (the rest wait for the next night).`);
      return { failuresInARow: failures, stopped: true };
    }
  }
  return { failuresInARow: failures, stopped: false };
}

/** Passes runDreamsUntilCaughtUp makes at most (each reads up to MAX_JOURNAL_ROWS_PER_DREAM rows per owner). */
export const MAX_CATCH_UP_PASSES = 100;
/** runDreamsUntilCaughtUp's dream-lease holder label by default (what the bot's scheduler logs while it waits). */
export const CATCH_UP_HOLDER = 'a catch-up dream (memory bootstrap)';

/**
 * Dreams until nothing is pending (the built-in bootstrap, whose history leaves people thousands of rows
 * above their watermark, where one night reads MAX_JOURNAL_ROWS_PER_DREAM per person): pass after pass over
 * everyone still pending (no per-night cap), then the group pass the same way, until no owner has rows
 * above their watermark. Someone whose dream fails is not retried in this run (they wait for the nightly
 * dream); MAX_FAILURES_IN_A_ROW failures in a row stop everything, as on a night. Uses only the stores and
 * client in `deps`, and never touches the nightly schedule's once-a-day claim (dreamSchedule.ts). It holds
 * the dream lease (dreamLease.ts, as `holder`) while it runs, so the bot's nightly dream waits for it; when
 * someone else holds it (the nightly dream is running), nothing is dreamed and `busy` says who. Never throws.
 */
export async function runDreamsUntilCaughtUp(
  deps: DreamDeps & { maxPasses?: number; holder?: string },
): Promise<NightlyDreamResult & { passes: number; caughtUp: boolean; busy?: DreamLeaseHolder }> {
  const now = (deps.now ?? (() => new Date()))();
  const day = easternDay(now);
  const client = deps.client ?? getOpenRouterClient();
  if (!client) {
    logger.warn('dream: OPENROUTER_API_KEY is not set; nothing dreamed.');
    return { day, people: [], passes: 0, caughtUp: false };
  }
  let taken: ReturnType<typeof takeDreamLease>;
  try {
    taken = takeDreamLease(deps.memory, deps.holder ?? CATCH_UP_HOLDER);
  } catch (error) {
    logger.warn('dream: taking the dream lease failed; nothing dreamed:', error);
    return { day, people: [], passes: 0, caughtUp: false };
  }
  if (!taken.ok) {
    logger.warn(
      `dream: ${taken.heldBy.holder} has been running since ${taken.heldBy.since} (Eastern); not catching up alongside it.`,
    );
    return { day, people: [], passes: 0, caughtUp: false, busy: taken.heldBy };
  }
  try {
    return await catchUp({ ...deps, client }, day, now, Math.max(1, deps.maxPasses ?? MAX_CATCH_UP_PASSES));
  } finally {
    taken.lease.release();
  }
}

/** runDreamsUntilCaughtUp's passes, under the lease. */
async function catchUp(
  deps: DreamDeps,
  day: string,
  now: Date,
  maxPasses: number,
): Promise<NightlyDreamResult & { passes: number; caughtUp: boolean }> {
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
      const run = await dreamPeople(pending, deps, people, failuresInARow);
      failuresInARow = run.failuresInARow;
      stopped = run.stopped;
      for (const outcome of people.slice(from)) {
        const done = outcome.status === 'failed' || outcome.status === 'skipped';
        if (done && outcome.owner.scope === 'person') settled.add(outcome.owner.ownerId);
      }
    }
    while (!stopped && passes < maxPasses) {
      const outcome = await dreamGroupIfDue(deps, now);
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
  /** Occasions shown in full. */
  occasions: Note[];
};

/**
 * What an edit of `target` shows the model, or an error when the target doesn't exist: one circle or
 * occasion (archived ones too: the owner may edit a trace); the group's notes with every live circle and
 * occasion; a person's notes with the live circles they are or were in and their live occasions.
 */
function editView(target: EditTarget, deps: DreamDeps): EditView | { error: string } {
  if (target.scope === 'circle') {
    const slug = normalizeTopic(target.slug);
    const circle = slug ? deps.notes.getCircle(slug) : undefined;
    if (!slug || !circle) return { error: `there is no circle "${target.slug}"` };
    const archived = isArchived(circle) ? ' It is archived: keep it archived unless the instruction revives it.' : '';
    return {
      scope: 'circle',
      what: `the circle "${circle.title}" (slug "${circle.topic}"): write exactly this circle, keeping its slug, or only archive it.${archived}`,
      label: `circle "${slug}"`,
      target: { scope: 'circle', slug },
      circles: [circle],
      occasions: [],
    };
  }
  if (target.scope === 'occasion') {
    const slug = normalizeTopic(target.slug);
    const occasion = slug ? deps.notes.getOccasion(slug) : undefined;
    if (!slug || !occasion) return { error: `there is no occasion "${target.slug}"` };
    return {
      scope: 'occasion',
      what: `the occasion "${occasion.title}" (slug "${occasion.topic}", status "${occasion.status ?? 'planned'}"): write exactly this occasion, keeping its slug`,
      label: `occasion "${slug}"`,
      target: { scope: 'occasion', slug },
      circles: [],
      occasions: [occasion],
    };
  }
  if (target.scope === 'group') {
    return {
      scope: 'group',
      what: "your notes on the group as a whole (the server's circles and occasions are shown too)",
      label: "the group's notes",
      target,
      notes: deps.notes.listNotes(target),
      circles: deps.notes.listCircles(),
      occasions: deps.notes.listOccasions(),
    };
  }
  const ownerId = canonicalUserId(target.ownerId);
  const name = nameResolver(deps.memory)(ownerId) ?? 'this member';
  return {
    scope: 'person',
    what: `your notes on ${name}: their profile, their topic notes, the circles they are or were in and their occasions`,
    label: `${name}'s notes (${ownerId})`,
    target: { scope: 'person', ownerId },
    notes: deps.notes.listNotes({ scope: 'person', ownerId }),
    circles: deps.notes.circlesOf(ownerId, { includeFormer: true }).map((c) => c.circle),
    occasions: deps.notes.occasionsOf(ownerId, { includeFormer: true }).map((o) => o.occasion),
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
    const now = (deps.now ?? (() => new Date()))();
    const today = easternToday(now);
    const circleView =
      view.scope === 'occasion'
        ? { text: '', excerptOnly: new Set<string>() }
        : renderCircles(
            view.scope === 'circle' ? 'THE CIRCLE' : 'CIRCLES',
            view.circles,
            nameOf,
            CIRCLES_FULL_BUDGET_CHARS,
            { targets: false },
          );
    const occasionView =
      view.scope === 'circle'
        ? { text: '', excerptOnly: new Set<string>() }
        : renderOccasions(
            view.scope === 'occasion' ? 'THE OCCASION' : 'OCCASIONS',
            [...view.occasions].sort(byOccasionRelevance(today)),
            nameOf,
            today,
            { view: { targets: false } },
          );
    const prompt = buildEditPrompt({
      now,
      roster: renderRoster(identities),
      what: view.what,
      notes: view.notes,
      circles: circleView.text,
      occasions: occasionView.text,
      instruction,
    });
    const owned = view.target.scope === 'person' ? accountIdsFor(view.target.ownerId) : [];
    const allowedIds = allowedIdsFrom(identities, [
      ...owned,
      ...circleMemberIds(view.circles),
      ...circleMemberIds(view.occasions),
    ]);
    const basis = notesBasis(deps.notes, view.target);

    const { result, costUsd } = await draftWithRepair<NotesOutput>({
      client,
      model: deps.model ?? config.dream.editModel,
      feature: EDIT_FEATURE,
      system: prompt.system,
      user: prompt.user,
      label: `edit: ${view.what}`,
      scope: view.scope,
      mode: 'edit',
      signal: request.signal,
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
        const excerpts = excerptOnlyProblems(parsed.value, circleView.excerptOnly, occasionView.excerptOnly);
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
    if (request.signal?.aborted) {
      logger.info(`memory edit: drafting for ${request.requestedBy} was stopped (the caller gave up waiting)`);
      return { ok: false, error: 'the draft was stopped: it took too long' };
    }
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

/** One note, circle or occasion a writer output would change, for a before/after preview. */
export type ProposedChange = {
  kind: 'note' | 'circle' | 'occasion';
  /** The topic, circle or occasion slug. */
  key: string;
  /** The new title (the current one for a removal). */
  title: string;
  change: 'added' | 'changed' | 'removed';
  /** Current content (absent when added). */
  before?: string;
  /** Proposed content (absent when removed). */
  after?: string;
  /** A circle's membership (an occasion's participants) now / as proposed (main ids). */
  membersBefore?: CircleMember[];
  membersAfter?: CircleMember[];
  /** A circle's or occasion's aliases now / as proposed. */
  aliasesBefore?: string[];
  aliasesAfter?: string[];
  /** A circle's or occasion's status, dates and place now / as proposed (a circle archived or revived). */
  detailsBefore?: NoteDetails;
  detailsAfter?: NoteDetails;
};

function sameMembership(a: CircleMember[], b: CircleMember[]): boolean {
  const key = (list: CircleMember[]) =>
    JSON.stringify([...list].sort((x, y) => (x.memberId < y.memberId ? -1 : x.memberId > y.memberId ? 1 : 0)));
  return key(a) === key(b);
}

/**
 * What saving `output` for `target` would change, against the store's current state: notes added,
 * changed or removed, circles added, changed (content, title, aliases, membership, archived or revived) or
 * removed/merged away, occasions added, changed (content, title, aliases, participants, dates, place,
 * status) or removed. Identical drafts are left out. Pure read; the order is notes (as in the output, then
 * removals), then circles, then occasions. A circle's membership after an archive shows its current
 * memberships ended, as the store saves them.
 */
export function previewChanges(notes: NotesStore, target: EditTarget, output: NotesOutput): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const owner = ownerTarget(target);
  if (owner) {
    const current = new Map(notes.listNotes(owner).map((n) => [n.topic, n]));
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
  const archiveMonth = notes.today().slice(0, 7);
  const archiving = new Set(output.archived_circles);
  const asMembers = (drafts: { id: string; since?: string | null; until?: string | null; role?: string | null }[]) =>
    drafts.map((m) => ({
      memberId: canonicalUserId(m.id),
      since: m.since ?? null,
      until: m.until ?? null,
      role: m.role ?? null,
    }));
  const circleDetails = (archived: boolean): NoteDetails => ({
    status: archived ? 'archived' : null,
    startsOn: null,
    endsOn: null,
    place: null,
    circle: null,
  });
  for (const draft of output.circles) {
    const existing = notes.getCircle(draft.slug);
    const archived = archiving.has(draft.slug);
    const drafted = asMembers(draft.members);
    const members = archived ? endCurrentMemberships(drafted, archiveMonth) : drafted;
    const detailsAfter = circleDetails(archived);
    const same =
      existing &&
      existing.title === draft.title &&
      existing.content === draft.content &&
      JSON.stringify(existing.aliases) === JSON.stringify(draft.aliases) &&
      sameMembership(existing.members, members) &&
      isArchived(existing) === archived;
    if (!same) {
      changes.push({
        kind: 'circle',
        key: draft.slug,
        title: draft.title,
        change: existing ? 'changed' : 'added',
        ...(existing
          ? {
              before: existing.content,
              membersBefore: existing.members,
              aliasesBefore: existing.aliases,
              detailsBefore: detailsOf(existing) ?? circleDetails(false),
            }
          : {}),
        after: draft.content,
        membersAfter: members,
        aliasesAfter: draft.aliases,
        detailsAfter,
      });
    }
    for (const merged of draft.merged_from) removedCircle(merged);
  }
  for (const slug of output.removed_circles) removedCircle(slug);
  // Circles archived as they are.
  for (const slug of output.archived_circles) {
    if (output.circles.some((c) => c.slug === slug)) continue;
    const existing = notes.getCircle(slug);
    if (!existing || isArchived(existing)) continue;
    changes.push({
      kind: 'circle',
      key: slug,
      title: existing.title,
      change: 'changed',
      before: existing.content,
      after: existing.content,
      membersBefore: existing.members,
      membersAfter: endCurrentMemberships(existing.members, archiveMonth),
      aliasesBefore: existing.aliases,
      aliasesAfter: existing.aliases,
      detailsBefore: circleDetails(false),
      detailsAfter: circleDetails(true),
    });
  }

  for (const draft of output.occasions) {
    const existing = notes.getOccasion(draft.slug);
    const members = asMembers(draft.participants);
    const detailsAfter: NoteDetails = {
      status: draft.status ?? existing?.status ?? defaultOccasionStatus(draft.starts_on, draft.ends_on, notes.today()),
      startsOn: draft.starts_on,
      endsOn: draft.ends_on,
      place: draft.place,
      circle: draft.circle,
    };
    const detailsBefore = existing ? (detailsOf(existing) ?? undefined) : undefined;
    const same =
      existing &&
      existing.title === draft.title &&
      existing.content === draft.content &&
      JSON.stringify(existing.aliases) === JSON.stringify(draft.aliases) &&
      sameMembership(existing.members, members) &&
      JSON.stringify(detailsBefore) === JSON.stringify(detailsAfter);
    if (same) continue;
    changes.push({
      kind: 'occasion',
      key: draft.slug,
      title: draft.title,
      change: existing ? 'changed' : 'added',
      ...(existing
        ? { before: existing.content, membersBefore: existing.members, aliasesBefore: existing.aliases, detailsBefore }
        : {}),
      after: draft.content,
      membersAfter: members,
      aliasesAfter: draft.aliases,
      detailsAfter,
    });
  }
  for (const slug of output.removed_occasions) {
    const existing = notes.getOccasion(slug);
    if (!existing) continue;
    changes.push({
      kind: 'occasion',
      key: slug,
      title: existing.title,
      change: 'removed',
      before: existing.content,
      membersBefore: existing.members,
      aliasesBefore: existing.aliases,
      detailsBefore: detailsOf(existing) ?? undefined,
    });
  }
  return changes;
}
