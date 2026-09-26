// The built-in bootstrap (docs/memory.md "Bootstrap" §4): the alternative to the Claude Code playbook, and
// the way to rebuild. It reads the message archive month by month (a busy month split into segments at
// its quiet gaps, each with a short lead-in), oldest first, with MEMORY_BOOTSTRAP_MODEL over OpenRouter
// (ZDR, tagged memory_bootstrap), and writes what it learns into the journal like capture does: dated
// rows (first/last seen backdated to when it was said), with evidence (the cited messages and a quote)
// and the other members involved. Knowledge carries forward: each segment sees what the journal already
// holds about the people in it, and a fact seen again is saved again so its recurrence counts (save()
// merges it into the existing row, widening its span). When every segment is done, the dream folds the
// journal into everyone's notes.
//
// `--dry-run` only counts: messages, segments, estimated tokens and cost from the model catalog's prices.
// A run is resumable: finished segments are recorded in memory.db (bot_state), so a stopped run picks up
// at the next one. Everything the model returns is untrusted: fields are checked, unknown people dropped,
// nothing with Discord markup saved.
import type OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import type { ArchiveStore } from '../../../archive/archiveStore';
import { canonicalUserId } from '../../../linkedAccounts';
import { logger } from '../../../logger';
import type { ModelPricing } from '../../modelCatalog';
import { featureRequestOptions } from '../../usage';
import type { JournalEvidence } from '../evidence';
import { type Memory, type MemoryStore, nameKey } from '../memoryStore';
import type { NightlyDreamResult } from '../notes/dreamer';
import type { NotesStore } from '../notes/notesStore';
import { noteTextProblems } from '../notes/schema';
import { lineCosts, planChunks } from './chunks';
import { easternDay } from './dates';
import { transcriptContext } from './export';
import { buildExportPeople, type ExportPeople, type ExportPerson } from './people';
import { buildTranscript, lineText, renderLeadIn, renderTranscript, type TranscriptLine } from './transcript';

/** Where a run records its finished segments (memory.db bot_state). */
export const BOOTSTRAP_PROGRESS_KEY = 'memory_bootstrap:progress';
/** The `source` of the journal rows a run writes. */
export const BOOTSTRAP_SOURCE = 'bootstrap';

// The output room per call. The default model (Opus) only reasons when asked, so this is all JSON; a
// reasoning model in MEMORY_BOOTSTRAP_MODEL still has room for a pass at its default effort.
const MAX_OUTPUT_TOKENS = 8_000;

export const BOOTSTRAP_DEFAULTS = {
  /** A month bigger than this is split at its quiet gaps. */
  segmentTokens: 60_000,
  leadInTokens: 1_500,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  /** What the journal already knows, shown per segment (the newest rows about its people). */
  knownRowsPerPerson: 25,
  knownContextMaxChars: 12_000,
} as const;

// The rough numbers behind a dry-run's estimate: the prompt around the transcript (rules, people, what is
// known), and how much the model writes per message read (about one observation per few dozen messages).
const ESTIMATE = { promptOverheadTokens: 5_000, outputTokensPerMessage: 1.5, minOutputTokens: 300 } as const;

// The dream afterwards: per person with notes to build, their journal in and notes out (rough).
const DREAM_ESTIMATE = { inputTokensPerPerson: 8_000, outputTokensPerPerson: 3_000 } as const;

const CATEGORIES = ['fact', 'preference', 'personality', 'vibe'] as const;
type BootstrapCategory = (typeof CATEGORIES)[number];
const MAX_CONTENT_CHARS = 200;

/** One call's worth of history. */
export type BootstrapSegment = {
  /** Stable across runs over the same archive: the month and its first message's id. */
  key: string;
  month: string;
  lines: TranscriptLine[];
  leadIn: TranscriptLine[];
  messages: number;
  /** Estimated tokens of the transcript part (lead-in included). */
  tokens: number;
};

export type BootstrapPlan = {
  people: ExportPeople;
  segments: BootstrapSegment[];
  months: number;
  messages: number;
};

/** The archive cut into segments: months, a month bigger than `segmentTokens` split at its quiet gaps. */
export function planBootstrap(
  archive: ArchiveStore,
  memory: MemoryStore,
  opts: { segmentTokens?: number; leadInTokens?: number; from?: string; to?: string } = {},
): BootstrapPlan {
  const people = buildExportPeople(memory, archive);
  const all = buildTranscript(archive.iterateMessages(), transcriptContext(archive, people));
  const inRange = (month: string) => (!opts.from || month >= opts.from) && (!opts.to || month <= opts.to);
  const costs = lineCosts(all);
  const segmentTokens = Math.max(1_000, opts.segmentTokens ?? BOOTSTRAP_DEFAULTS.segmentTokens);
  const leadInTokens = Math.max(0, opts.leadInTokens ?? BOOTSTRAP_DEFAULTS.leadInTokens);

  const segments: BootstrapSegment[] = [];
  const months = new Set<string>();
  let start = 0;
  while (start < all.length) {
    const month = all[start].day.slice(0, 7);
    let end = start;
    while (end < all.length && all[end].day.slice(0, 7) === month) end++;
    if (inRange(month)) {
      months.add(month);
      const monthLines = all.slice(start, end);
      for (const range of planChunks(monthLines, { targetTokens: segmentTokens, leadInTokens: 0 })) {
        const from = start + range.start;
        const to = start + range.end;
        let lead = from;
        let leadTokens = 0;
        while (lead > 0 && leadTokens + costs[lead - 1] <= leadInTokens) leadTokens += costs[--lead];
        const lines = all.slice(from, to);
        segments.push({
          key: `${month}:${lines[0].messageIds[0]}`,
          month,
          lines,
          leadIn: all.slice(lead, from),
          messages: lines.reduce((n, l) => n + l.messageIds.length, 0),
          tokens: costs.slice(lead, to).reduce((a, b) => a + b, 0),
        });
      }
    }
    start = end;
  }
  return { people, segments, months: months.size, messages: segments.reduce((n, s) => n + s.messages, 0) };
}

export type BootstrapEstimate = {
  model: string;
  months: number;
  messages: number;
  segments: number;
  /** Segments a run would still do (not yet recorded as finished). */
  remaining: number;
  inputTokens: number;
  outputTokens: number;
  pricing?: ModelPricing;
  costUsd?: number;
  /** The dream that folds the journal into notes afterwards (people with messages), when priced. */
  dream: { people: number; model: string; pricing?: ModelPricing; costUsd?: number };
};

/** A dry run: how much a run over `plan` would read and write, and what it would cost. */
export function estimateBootstrap(
  plan: BootstrapPlan,
  opts: {
    model: string;
    pricing?: ModelPricing;
    dreamModel: string;
    dreamPricing?: ModelPricing;
    done?: ReadonlySet<string>;
  },
): BootstrapEstimate {
  const todo = plan.segments.filter((s) => !opts.done?.has(s.key));
  const inputTokens = todo.reduce((n, s) => n + ESTIMATE.promptOverheadTokens + s.tokens, 0);
  const outputTokens = todo.reduce(
    (n, s) =>
      n +
      Math.min(
        BOOTSTRAP_DEFAULTS.maxOutputTokens,
        Math.max(ESTIMATE.minOutputTokens, Math.round(s.messages * ESTIMATE.outputTokensPerMessage)),
      ),
    0,
  );
  const cost = (pricing: ModelPricing | undefined, input: number, output: number) =>
    pricing ? input * pricing.promptUsdPerToken + output * pricing.completionUsdPerToken : undefined;
  const dreamPeople = plan.people.people.filter((p) => p.messages > 0).length;
  return {
    model: opts.model,
    months: plan.months,
    messages: plan.messages,
    segments: plan.segments.length,
    remaining: todo.length,
    inputTokens,
    outputTokens,
    pricing: opts.pricing,
    costUsd: cost(opts.pricing, inputTokens, outputTokens),
    dream: {
      people: dreamPeople,
      model: opts.dreamModel,
      pricing: opts.dreamPricing,
      costUsd: cost(
        opts.dreamPricing,
        dreamPeople * DREAM_ESTIMATE.inputTokensPerPerson,
        dreamPeople * DREAM_ESTIMATE.outputTokensPerPerson,
      ),
    },
  };
}

// ---- Progress ----

export type BootstrapProgress = {
  version: 1;
  model: string;
  /** Keys of finished segments. */
  done: string[];
  rows: number;
  costUsd: number;
  startedAt: string;
  updatedAt: string;
};

export function readProgress(memory: MemoryStore): BootstrapProgress | undefined {
  const raw = memory.getState(BOOTSTRAP_PROGRESS_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<BootstrapProgress>;
    if (parsed.version !== 1 || !Array.isArray(parsed.done)) return undefined;
    return {
      version: 1,
      model: typeof parsed.model === 'string' ? parsed.model : '',
      done: parsed.done.filter((k): k is string => typeof k === 'string'),
      rows: typeof parsed.rows === 'number' ? parsed.rows : 0,
      costUsd: typeof parsed.costUsd === 'number' ? parsed.costUsd : 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return undefined;
  }
}

function writeProgress(memory: MemoryStore, progress: BootstrapProgress): void {
  memory.setState(BOOTSTRAP_PROGRESS_KEY, JSON.stringify(progress));
}

// ---- The prompt ----

/** The people a segment involves: its authors, and anyone it names (by any name they go by). */
function peopleIn(segment: BootstrapSegment, people: ExportPeople): ExportPerson[] {
  const lines = [...segment.leadIn, ...segment.lines];
  const text = nameKey(lines.map((l) => l.body).join('\n'));
  const authors = new Set(lines.map((l) => l.author));
  return people.people.filter((p) => {
    if (authors.has(p.name)) return true;
    return [p.name, p.realName, ...p.nicknames, ...p.otherNames].some((name) => {
      const key = nameKey(name);
      if (key.length < 3) return false;
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);
    });
  });
}

function personLine(p: ExportPerson): string {
  const parts: string[] = [];
  if (p.realName) parts.push(`real name ${p.realName}`);
  if (p.nicknames.length > 0) parts.push(`also called ${p.nicknames.join(', ')}`);
  const other = p.otherNames.filter((n) => !p.nicknames.includes(n) && n !== p.realName).slice(0, 5);
  if (other.length > 0) parts.push(`also went by ${other.join(', ')}`);
  return `- ${p.name} (id:${p.id})${parts.length > 0 ? ` — ${parts.join('; ')}` : ''}`;
}

/** A journal row as the "already known" context shows it: category, content, span and recurrence. */
function knownLine(row: Memory, name: string): string {
  const first = row.first_seen_at?.slice(0, 7) ?? row.created_at.slice(0, 7);
  const last = row.last_seen_at?.slice(0, 7) ?? row.updated_at.slice(0, 7);
  const span = first === last ? first : `${first}–${last}`;
  const seen = (row.seen_count ?? 1) > 1 ? `, seen ${row.seen_count}×` : '';
  return `- [${row.category}] ${name}: ${row.content} (${span}${seen})`;
}

/** What the journal already holds about the segment's people and the server, newest first, capped. */
function knownContext(memory: MemoryStore, involved: ExportPerson[]): string {
  const lines: string[] = [];
  const seen = new Set<number>();
  const push = (rows: Memory[], name: string) => {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      lines.push(knownLine(row, name));
    }
  };
  for (const person of involved) {
    push(
      memory.getForPerson(
        { userId: person.id, names: [person.name, ...person.otherNames] },
        BOOTSTRAP_DEFAULTS.knownRowsPerPerson,
      ),
      person.name,
    );
  }
  push(memory.getBySubject('server', BOOTSTRAP_DEFAULTS.knownRowsPerPerson), 'server');
  let text = '';
  for (const line of lines) {
    if (text.length + line.length + 1 > BOOTSTRAP_DEFAULTS.knownContextMaxChars) break;
    text += `${line}\n`;
  }
  return text.trim() || '(nothing yet)';
}

/**
 * The extraction prompt: the capture extractor's rules (the 30-day test, atomic rows, subjects by id, no
 * censoring) adapted to history read years later: notable history is worth keeping, every row is dated,
 * and a fact seen again is repeated so its recurrence counts.
 */
export function buildBootstrapPrompt(args: {
  month: string;
  people: string;
  known: string;
  transcript: string;
}): string {
  return `You are reading the chat history of a private Discord friend group (${args.month}) to build its long-term memory about the members, the way a friend would remember them years later. You read the history in order, one stretch at a time; what is already known from earlier stretches is listed below.

Transcript format: "## YYYY-MM-DD (Weekday)" per day, "### #channel" per channel run, then "Name: text" lines (a line starting with HH:MM opens a conversation after a quiet spell; times are US Eastern). One person's consecutive messages share a line, joined by " / ". (↩ Name) marks a reply, [voice: …] a voice message's transcript, [file: …] an attachment, [link: …] a link preview's title. "bot" is the group's bot itself: never a subject. Lines under "ALREADY COVERED" are context from the previous stretch: never extract from them.

WHAT TO SAVE:
- Durable knowledge about people: jobs, studies, where they live, relationships, family, pets, hobbies, games they play, skills, goals, strong likes and dislikes, how they talk and joke, long-running habits.
- Notable history worth remembering years later: moves, new jobs, breakups, trips, legendary moments, running jokes and where they started, group traditions. Write history with its date in the text ("Moved to Montreal in 2019-06.").
- Server-wide culture (in-jokes, traditions, group dynamics): category "vibe", no subject_user_id.
- Relationships and shared events involve several people: file the row under one of them and list the others in related_user_ids.

WHAT NOT TO SAVE:
- The conversation itself (someone asked, answered, joined, reacted): record what a message REVEALS, never what it DID.
- Small talk, greetings, one-off moods, plans that only mattered that week.
- Guesses beyond what was said, or things only inferred from what others say about someone.
- Real names and nicknames as observations (they are already known from the people list).

RULES:
1. One atomic fact per row, plain declarative sentences, "content" ≤ ${MAX_CONTENT_CHARS} characters. No Discord mention, emoji or channel syntax, and no ids in "content": describe emoji style in words.
2. "subject_user_id" is the person's id from the people list below (their main id); omit it for a server-wide "vibe" row. "related_user_ids" are the ids of the other members the row is also about.
3. "date": when it was said or happened, YYYY-MM-DD (or YYYY-MM).
4. "quote": a short verbatim excerpt (≤ 200 characters) of the key passage in THIS stretch, copied exactly from one transcript line (without the time and name).
5. Already known (see below): do not restate it in new words. But when this stretch shows it AGAIN, emit it again with the SAME content, so it counts as seen again. When it changed (quit a game, moved, broke up), save the new state as a new row.
6. Observations stay verbatim to what people are like: no softening, no censoring, no moralizing.
7. Categories: "fact" (durable facts and history), "preference" (likes, dislikes, strong opinions), "personality" (how they talk, joke and behave), "vibe" (server-wide culture).

People (transcript name → id):
${args.people}

Already known (earlier history and the bot's journal; span and how often seen):
${args.known}

Respond ONLY with a JSON object; with nothing worth saving, {"observations": []}.
{"observations": [{"category": "fact|preference|personality|vibe", "subject_user_id": "id, or omit for vibe", "related_user_ids": ["id"], "content": "atomic statement", "date": "YYYY-MM-DD", "quote": "verbatim excerpt"}]}

${args.transcript}`;
}

/** A segment's transcript part: its lead-in (quoted, under ALREADY COVERED) and its own lines. */
export function renderSegment(segment: BootstrapSegment): string {
  const out: string[] = [];
  if (segment.leadIn.length > 0) {
    out.push('## ALREADY COVERED — context only, do not extract', ...renderLeadIn(segment.leadIn), '');
    out.push('## NEW — extract from here', '');
  }
  out.push(...renderTranscript(segment.lines).lines);
  return out.join('\n');
}

// ---- Parsing the answer ----

export type BootstrapObservation = {
  category: BootstrapCategory;
  subjectUserId?: string;
  relatedUserIds: string[];
  content: string;
  /** When it was said (epoch ms). */
  observedAt: number;
  evidence?: JournalEvidence;
};

function normalizedForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The transcript line a quote comes from (exact text, whitespace and case aside), or undefined. */
function lineOfQuote(segment: BootstrapSegment, quote: string): TranscriptLine | undefined {
  const needle = normalizedForMatch(quote.replace(/^(?:\d{2}:\d{2} )?[^:]{1,80}: /, ''));
  if (needle.length < 3) return undefined;
  return segment.lines.find((line) => normalizedForMatch(lineText(line, true)).includes(needle));
}

/** A YYYY-MM-DD / YYYY-MM date as epoch ms (noon UTC), when it falls within [min, max] ± a month. */
function dateMs(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return undefined;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] ?? '15'), 12);
  const slack = 31 * 24 * 60 * 60 * 1000;
  return Number.isFinite(ms) && ms >= min - slack && ms <= max + slack ? ms : undefined;
}

/**
 * The model's answer as observations about known people. Anything malformed is dropped (and counted): an
 * unknown category, a subject or related id nobody in the export has, content that is empty, too long or
 * carries Discord markup or ids. The observed time is the quoted line's (when the quote is found), else
 * the given date, else the segment's start; the evidence cites the quoted line's messages.
 */
export function parseBootstrapAnswer(
  text: string,
  segment: BootstrapSegment,
  people: ExportPeople,
): { observations: BootstrapObservation[]; dropped: number } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: unknown;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch {
    return { observations: [], dropped: 0 };
  }
  const raw = (parsed as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(raw)) return { observations: [], dropped: 0 };

  const first = segment.lines[0]?.startMs ?? 0;
  const last = segment.lines.at(-1)?.endMs ?? first;
  const observations: BootstrapObservation[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const fields = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const category = CATEGORIES.find(
      (c) =>
        c ===
        String(fields.category ?? '')
          .trim()
          .toLowerCase(),
    );
    const content = typeof fields.content === 'string' ? fields.content.replace(/\s+/g, ' ').trim() : '';
    const subjectRaw = typeof fields.subject_user_id === 'string' ? fields.subject_user_id.trim() : '';
    const subject = subjectRaw ? people.byAccount(subjectRaw) : undefined;
    if (
      !category ||
      !content ||
      content.length > MAX_CONTENT_CHARS ||
      noteTextProblems(content).length > 0 ||
      (subjectRaw && !subject) ||
      (!subject && category !== 'vibe')
    ) {
      dropped++;
      continue;
    }
    const related = (Array.isArray(fields.related_user_ids) ? fields.related_user_ids : [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => people.byAccount(id.trim())?.id)
      .filter((id): id is string => id !== undefined && id !== subject?.id);
    const quote = typeof fields.quote === 'string' ? fields.quote.trim() : '';
    const line = quote ? lineOfQuote(segment, quote) : undefined;
    const observedAt = line?.startMs ?? dateMs(fields.date, first, last) ?? first;
    const evidence =
      line || quote ? { messageIds: line?.messageIds.slice(0, 12) ?? [], ...(quote ? { quote } : {}) } : undefined;
    observations.push({
      category,
      ...(subject && category !== 'vibe' ? { subjectUserId: subject.id } : {}),
      relatedUserIds: [...new Set(related)],
      content,
      observedAt,
      ...(evidence ? { evidence } : {}),
    });
  }
  return { observations, dropped };
}

// ---- Running ----

export type BootstrapRunDeps = {
  archive: ArchiveStore;
  memory: MemoryStore;
  notes: NotesStore;
  client: OpenAI;
  model: string;
  now?: () => Date;
  /** Only these months (YYYY-MM, inclusive). */
  from?: string;
  to?: string;
  segmentTokens?: number;
  /**
   * Runs the dream for everyone with new journal rows once every segment of the whole archive is done
   * (not after a --from/--to range; skipped when absent).
   */
  dream?: (maxPeople: number) => Promise<NightlyDreamResult>;
  /** Progress lines (the CLI prints them). */
  log?: (line: string) => void;
  /** Stop after this many segments (a trial run); the rest waits for the next run. */
  maxSegments?: number;
};

export type BootstrapRunResult = {
  segmentsDone: number;
  segmentsFailed: number;
  segmentsLeft: number;
  rows: number;
  dropped: number;
  costUsd: number;
  dream?: NightlyDreamResult | { error: string };
};

type ChatBody = {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: 'user'; content: string }>;
  provider: { zdr: true };
};

/** One segment: the model call and the journal rows it yields. Throws on a failed call. */
async function extractSegment(
  segment: BootstrapSegment,
  plan: BootstrapPlan,
  deps: BootstrapRunDeps,
): Promise<{ rows: number; dropped: number; costUsd: number }> {
  const involved = peopleIn(segment, plan.people);
  const prompt = buildBootstrapPrompt({
    month: segment.month,
    people: involved.map(personLine).join('\n') || '(nobody identified)',
    known: knownContext(deps.memory, involved),
    transcript: renderSegment(segment),
  });
  const body: ChatBody = {
    model: deps.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
    provider: { zdr: true },
  };
  // The SDK's types don't know OpenRouter's `provider` routing: bridged here, once.
  const response = await deps.client.chat.completions.create(
    body as unknown as ChatCompletionCreateParamsNonStreaming,
    featureRequestOptions('memory_bootstrap'),
  );
  const costUsd = Number((response.usage as { cost?: unknown } | undefined)?.cost) || 0;
  const text = response.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error(`empty answer (finish=${response.choices?.[0]?.finish_reason ?? 'none'})`);
  const { observations, dropped } = parseBootstrapAnswer(text, segment, plan.people);

  let rows = 0;
  for (const obs of observations) {
    const subject = obs.subjectUserId ? plan.people.byAccount(obs.subjectUserId) : undefined;
    await deps.memory.save({
      category: obs.category,
      subject: subject ? (deps.memory.getIdentityById(subject.id)?.display_name ?? subject.name) : 'server',
      subject_user_id: subject ? canonicalUserId(subject.id) : undefined,
      content: obs.content,
      source: BOOTSTRAP_SOURCE,
      evidence: obs.evidence,
      observed_at: new Date(obs.observedAt),
      related_user_ids: obs.relatedUserIds,
    });
    rows++;
  }
  return { rows, dropped, costUsd };
}

/**
 * A run (see the file comment): every unfinished segment, oldest first, one call each; finished segments
 * are recorded as they complete, so an interrupted run resumes at the next one. A failed segment is logged
 * and left for the next run (the run goes on). The dream runs only once nothing of the archive is left.
 */
export async function runBootstrap(deps: BootstrapRunDeps): Promise<BootstrapRunResult> {
  const log = deps.log ?? ((line: string) => logger.info(`memory bootstrap: ${line}`));
  const now = deps.now ?? (() => new Date());
  const plan = planBootstrap(deps.archive, deps.memory, {
    segmentTokens: deps.segmentTokens,
    from: deps.from,
    to: deps.to,
  });
  const stamp = now().toISOString();
  const progress = readProgress(deps.memory) ?? {
    version: 1 as const,
    model: deps.model,
    done: [],
    rows: 0,
    costUsd: 0,
    startedAt: stamp,
    updatedAt: stamp,
  };
  const done = new Set(progress.done);
  const todo = plan.segments.filter((s) => !done.has(s.key));
  const result: BootstrapRunResult = {
    segmentsDone: 0,
    segmentsFailed: 0,
    segmentsLeft: todo.length,
    rows: 0,
    dropped: 0,
    costUsd: 0,
  };
  log(`${todo.length} of ${plan.segments.length} segments to read with ${deps.model}`);

  for (const segment of todo) {
    if (deps.maxSegments !== undefined && result.segmentsDone + result.segmentsFailed >= deps.maxSegments) break;
    const label = `${segment.month} (${segment.messages} messages, ${easternDay(segment.lines[0].startMs)} → ${easternDay(segment.lines.at(-1)?.endMs ?? 0)})`;
    try {
      const outcome = await extractSegment(segment, plan, deps);
      done.add(segment.key);
      result.segmentsDone++;
      result.segmentsLeft--;
      result.rows += outcome.rows;
      result.dropped += outcome.dropped;
      result.costUsd += outcome.costUsd;
      progress.done = [...done];
      progress.rows += outcome.rows;
      progress.costUsd += outcome.costUsd;
      progress.updatedAt = now().toISOString();
      writeProgress(deps.memory, progress);
      log(
        `${label}: ${outcome.rows} rows${outcome.dropped > 0 ? ` (${outcome.dropped} dropped)` : ''}${outcome.costUsd > 0 ? ` · $${outcome.costUsd.toFixed(4)}` : ''} · ${result.segmentsLeft} left`,
      );
    } catch (error) {
      result.segmentsFailed++;
      log(`${label}: FAILED, left for the next run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A range (--from/--to) is a partial read: the dream waits for a run over the whole archive.
  if (result.segmentsLeft === 0 && deps.dream && !deps.from && !deps.to) {
    const pending = deps.notes.pendingDreams().people.length;
    log(`every segment is read: dreaming ${pending} people into notes`);
    try {
      result.dream = await deps.dream(Math.max(1, pending));
    } catch (error) {
      result.dream = { error: error instanceof Error ? error.message : String(error) };
      log(`the dream failed (the nightly dream will pick the journal up): ${result.dream.error}`);
    }
  }
  return result;
}
