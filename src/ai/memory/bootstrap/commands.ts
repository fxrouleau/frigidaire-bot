// The memory bootstrap's command line (docs/memory.md "Bootstrap"). Entry point: cli.ts, which runs in the
// prod container (`docker exec -u node frigidaire-bot node dist/ai/memory/bootstrap/cli.js <command>`) and
// locally (`yarn memory <command>`). Each command reads the bot's data folder (./data) and prints what it
// did; exit code 0 on success, 1 on a problem, 2 on a usage error.
//
//   export        archive.db → data/memory-bootstrap/export/ (transcripts, chunks, people.json, manifest)
//   import --check  validate a notes tree without loading it (the load itself happens at bot startup)
//   observations  validate the playbook's observation log; rebuild its per-person views and cast sheet
//   bootstrap     the built-in bootstrap over OpenRouter: --dry-run (estimate) or --run
//   archive       put circles and occasions away now, as the nightly lifecycle pass would: --dry-run lists
import * as fs from 'node:fs';
import * as path from 'node:path';
import type OpenAI from 'openai';
import { ArchiveStore } from '../../../archive/archiveStore';
import { config } from '../../../config';
import type { ModelPricing } from '../../modelCatalog';
import { makeDefaultEmbeddingProvider } from '../embeddingProvider';
import { MemoryStore } from '../memoryStore';
import {
  archiveShared,
  type LifecycleOutcome,
  type NightlyDreamResult,
  runDreamsUntilCaughtUp,
} from '../notes/dreamer';
import { takeDreamLease } from '../notes/dreamLease';
import {
  type ActivityMonth,
  circlePresence,
  easternToday,
  isArchived,
  parseActivitySeed,
  yearlyCadence,
} from '../notes/lifecycle';
import { type Note, NotesStore } from '../notes/notesStore';
import { loadEvidencePassages } from '../notes/passages';
import { NOTE_LIMITS, normalizeTopic } from '../notes/schema';
import {
  type BootstrapEstimate,
  estimateBootstrap,
  planBootstrap,
  readProgress,
  resolveSegmentTokens,
  runBootstrap,
} from './builtin';
import { CHUNK_DEFAULTS } from './chunks';
import { DEFAULT_EXPORT_DIR, runExport } from './export';
import {
  checkNotesTree,
  DEFAULT_IMPORT_DIR,
  type KnownPeople,
  knownPeopleFromJson,
  knownPeopleFromStores,
} from './importer';
import { splitObservations, writeCastSheet } from './observations';
import { counted, formatCount, formatUsd } from './tokens';

export const DEFAULT_DATA_DIR = './data';
/** The playbook's working folder (observations, working notes, the final tree). */
export const DEFAULT_WORK_DIR = './data/memory-bootstrap/work';

export type CliIo = { out: (line: string) => void; err: (line: string) => void };

/** What the commands need from the outside world; tests inject every piece. */
export type CliDeps = {
  io: CliIo;
  /** The bot's data folder (archive.db and memory.db live here). */
  dataDir?: string;
  /** Opens the stores (default: the files in dataDir). Only called when a command needs them. */
  openStores?: () => { archive: ArchiveStore; memory: MemoryStore; notes: NotesStore };
  /** The OpenRouter client for `bootstrap --run` (default: the shared one; undefined without a key). */
  client?: () => OpenAI | undefined;
  /** Per-token prices from the model catalog. */
  priceOf?: (model: string) => Promise<ModelPricing | undefined>;
  /**
   * The dream after a finished run: dreams everyone pending until nothing is (runDreamsUntilCaughtUp), over
   * these stores (never the bot's shared ones) and without claiming the nightly schedule's day.
   */
  dream?: (
    stores: { archive: ArchiveStore; memory: MemoryStore; notes: NotesStore },
    client: OpenAI,
  ) => Promise<NightlyDreamResult & { caughtUp?: boolean }>;
  now?: () => Date;
};

export const USAGE = `usage: memory <command> [options]

  export [--out DIR] [--chunk-tokens N] [--lead-in-tokens N]
      Write the message archive as compact transcripts for the bootstrap playbook
      (default ${DEFAULT_EXPORT_DIR}; chunks of ~${CHUNK_DEFAULTS.targetTokens} tokens, lead-ins of ~${CHUNK_DEFAULTS.leadInTokens}).

  import --check [DIR] [--people FILE]
      Validate a notes tree (default ${DEFAULT_IMPORT_DIR}) exactly as the startup import would,
      without loading it. Known people come from --people, DIR/people.json, or the bot's databases.

  observations [WORKDIR] [--people FILE]
      Validate the playbook's observations/*.jsonl and rebuild by-person/, by-circle/ and cast.md
      (default ${DEFAULT_WORK_DIR}; people.json from --people or the export next to it).

  bootstrap --dry-run | --run [--from YYYY-MM] [--to YYYY-MM] [--segment-tokens N]
            [--max-segments N] [--no-dream]
      The built-in bootstrap over OpenRouter (MEMORY_BOOTSTRAP_MODEL, zero data retention):
      --dry-run counts and prices it; --run reads the archive into the journal (resumable),
      then dreams everyone's notes once the whole archive is read.

  archive <slug>… [--dry-run]
      Put circles and occasions away now (a slug may say which: circle:yugioh, occasion:ski-trip-2027):
      each is compacted to a short historical trace (one MEMORY_DREAM_MODEL call, zero data retention),
      a circle's current memberships end, and it stays readable and searchable. --dry-run lists them.

  seed-activity <file.json> [--dry-run]
      Record circles' activity by month from the archive, {"<slug>": {"2019-03": 12, …}, …} (a month
      already recorded keeps the larger weight, so running it twice changes nothing). It says how each
      circle stands afterwards (present, fading, or due for archiving tonight). --dry-run only says.`;

type Args = { positional: string[]; flags: Map<string, string | true> };

const VALUE_FLAGS = new Set([
  'out',
  'chunk-tokens',
  'lead-in-tokens',
  'people',
  'from',
  'to',
  'segment-tokens',
  'max-segments',
]);
const BOOLEAN_FLAGS = new Set(['check', 'dry-run', 'run', 'no-dream']);

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else throw new UsageError(`unknown option --${name}`);
  }
  return { positional, flags };
}

function intFlag(args: Args, name: string, min: number): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(value) || value < min) {
    throw new UsageError(`--${name} must be a whole number ≥ ${min}`);
  }
  return value;
}

function monthFlag(args: Args, name: string): string | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(raw))
    throw new UsageError(`--${name} must be YYYY-MM`);
  return raw;
}

function stringFlag(args: Args, name: string): string | undefined {
  const raw = args.flags.get(name);
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The bot's databases in `dataDir` (embeddings on when a key is set, so the built-in bootstrap's rows dedup
 * semantically like capture's). Refuses to create empty ones by accident (a check on a laptop without the
 * bot's data).
 */
export function openDataStores(dataDir: string): { archive: ArchiveStore; memory: MemoryStore; notes: NotesStore } {
  for (const file of ['archive.db', 'memory.db']) {
    if (!fs.existsSync(path.join(dataDir, file))) {
      throw new UsageError(`${path.join(dataDir, file)} not found: run this where the bot's data folder is`);
    }
  }
  const memory = new MemoryStore(path.join(dataDir, 'memory.db'), { embeddings: makeDefaultEmbeddingProvider() });
  return { archive: new ArchiveStore(path.join(dataDir, 'archive.db')), memory, notes: new NotesStore(memory) };
}

/**
 * The dream after a finished `bootstrap --run`: runDreamsUntilCaughtUp over the CLI's own stores (its
 * memory.db and notes, and its archive.db for the cited passages), never the bot's shared singletons. It
 * doesn't touch the nightly schedule's once-a-day claim (bot_state `dream:last_night`, which only
 * dreamSchedule.ts sets), so the bot's own dream still runs that night for whatever is new by then. It
 * holds the dream lease while it runs (the bot's night waits for it), and throws when the bot is dreaming
 * right now: two dreams at once would pay twice for the same people.
 */
export async function dreamOverStores(
  stores: { archive: ArchiveStore; memory: MemoryStore; notes: NotesStore },
  client: OpenAI,
  opts: { now?: () => Date } = {},
): Promise<NightlyDreamResult & { caughtUp: boolean }> {
  const result = await runDreamsUntilCaughtUp({
    memory: stores.memory,
    notes: stores.notes,
    client,
    holder: 'the memory bootstrap (CLI)',
    ...(opts.now ? { now: opts.now } : {}),
    loadPassages: (ids, passageOpts) => loadEvidencePassages(ids, { ...passageOpts, archive: stores.archive }),
  });
  if (result.busy) {
    throw new Error(
      `${result.busy.holder} has been running since ${result.busy.since} (Eastern). Run \`memory bootstrap --run\` again once it is done: every segment is read, so it goes straight to the dream`,
    );
  }
  return result;
}

/**
 * The archive's history import (ARCHIVE_BACKFILL_CHANNELS, src/archive/backfill.ts) as the bot has left it in
 * archive.db: `running` = channels whose import hasn't started or finished (the bot is still paging them
 * backwards), `failing` = channels stuck on an error (usually a missing permission; the bot retries hourly,
 * but nothing says it will ever get through). Both the export and the built-in bootstrap read the archive as
 * it is: history that lands afterwards is never read (a finished segment is never read again), and a month
 * that grows shifts the segments' boundaries. So they wait for a running import, and warn about a failing one.
 */
export function historyImportState(archive: ArchiveStore): { running: string[]; failing: string[] } {
  const running: string[] = [];
  const failing: string[] = [];
  if (!config.archive.enabled || !config.archive.backfillEnabled) return { running, failing };
  for (const channelId of config.archive.backfillChannels) {
    const name = archive.getChannel(channelId)?.name;
    const label = name ? `#${name}` : `channel ${channelId}`;
    const state = archive.getBackfillState(channelId);
    if (state?.done) continue;
    if (!state) running.push(`${label} (not started)`);
    else if (state.lastError) failing.push(`${label} (${state.lastError})`);
    else running.push(`${label} (${counted(state.fetched, 'message')} so far)`);
  }
  return { running, failing };
}

/**
 * Prints the history import's problems. Returns false (after an error line) when an import is still
 * running and `refuse` is set; a dry run only gets the warning.
 */
function checkHistoryImport(archive: ArchiveStore, deps: CliDeps, what: string, refuse: boolean): boolean {
  const { running, failing } = historyImportState(archive);
  for (const channel of failing) {
    deps.io.out(`warning: the history import of ${channel} keeps failing: its older history is not in the archive.`);
  }
  if (running.length === 0) return true;
  const line = `the archive is still importing history (${running.join(', ')})`;
  if (!refuse) {
    deps.io.out(`warning: ${line}: these numbers will grow; run it once the import is finished.`);
    return true;
  }
  deps.io.err(
    `Not now: ${line}. ${what} reads the archive as it is, and history that lands later would never be read. Keep the bot running until its log says the import is done, then run this again.`,
  );
  return false;
}

function describeEstimate(e: BootstrapEstimate): string[] {
  const price = (pricing: ModelPricing | undefined) =>
    pricing
      ? `$${(pricing.promptUsdPerToken * 1e6).toFixed(2)}/M in, $${(pricing.completionUsdPerToken * 1e6).toFixed(2)}/M out`
      : 'price unknown (the model catalog is unreachable or does not list it)';
  return [
    `Archive: ${counted(e.messages, 'message')} over ${counted(e.months, 'month')} → ${counted(e.segments, 'segment')} (${formatCount(e.remaining)} still to read).`,
    `Model: ${e.model} (${price(e.pricing)}).`,
    `Estimated: ~${formatCount(e.inputTokens)} input + ~${formatCount(e.outputTokens)} output tokens${e.costUsd !== undefined ? ` ≈ ${formatUsd(e.costUsd)}` : ''}.`,
    `Then the dream: ~${counted(e.dream.people, 'person', 'people')} with ${e.dream.model}${e.dream.costUsd !== undefined ? ` ≈ ${formatUsd(e.dream.costUsd)}` : ''} (rough).`,
    'Rough estimates (±50%): tokens are estimated from characters, the output from message counts.',
  ];
}

async function exportCommand(args: Args, deps: CliDeps): Promise<number> {
  const stores = (deps.openStores ?? (() => openDataStores(deps.dataDir ?? DEFAULT_DATA_DIR)))();
  const outDir = stringFlag(args, 'out') ?? DEFAULT_EXPORT_DIR;
  if (!checkHistoryImport(stores.archive, deps, 'The export', true)) return 1;
  const manifest = runExport({
    ...stores,
    outDir,
    chunkTokens: intFlag(args, 'chunk-tokens', 1_000),
    leadInTokens: intFlag(args, 'lead-in-tokens', 0),
    now: deps.now,
  });
  const t = manifest.totals;
  deps.io.out(
    `Exported ${counted(t.messages, 'message')} (${manifest.range.first ?? '—'} → ${manifest.range.last ?? '—'}) to ${path.resolve(outDir)}`,
  );
  deps.io.out(
    `  ${counted(manifest.months.length, 'monthly file')}: ~${formatCount(t.tokens)} tokens (framing ${(t.framing_ratio * 100).toFixed(1)}% of the text)`,
  );
  deps.io.out(
    `  ${counted(manifest.chunks.length, 'chunk')} of ≤ ~${formatCount(manifest.chunking.target_tokens)} tokens: ~${formatCount(t.chunk_tokens)} tokens with lead-ins`,
  );
  deps.io.out(
    `  ${counted(manifest.people.count, 'person', 'people')} in people.json; journal high-water mark #${manifest.journal_high_water}`,
  );
  deps.io.out('It is private chat: keep it in the data volume, or wherever you run the playbook, and delete it after.');
  return 0;
}

function knownFor(args: Args, dir: string, deps: CliDeps): { known: KnownPeople; journalHighWater?: number } {
  const peopleFile =
    stringFlag(args, 'people') ??
    (fs.existsSync(path.join(dir, 'people.json')) ? path.join(dir, 'people.json') : undefined);
  if (peopleFile) {
    const read = knownPeopleFromJson(peopleFile);
    if (!read.ok) throw new UsageError(read.error);
    return { known: read.known };
  }
  const stores = (deps.openStores ?? (() => openDataStores(deps.dataDir ?? DEFAULT_DATA_DIR)))();
  return {
    known: knownPeopleFromStores(stores.memory, config.archive.enabled ? stores.archive : undefined),
    journalHighWater: stores.notes.journalHighWater(),
  };
}

async function importCommand(args: Args, deps: CliDeps): Promise<number> {
  if (!args.flags.has('check')) {
    deps.io.err(
      `The import runs when the bot starts: put the notes tree in ${DEFAULT_IMPORT_DIR}/ and restart it. Use --check to validate a tree first.`,
    );
    return 2;
  }
  const dir = args.positional[0] ?? DEFAULT_IMPORT_DIR;
  const { known, journalHighWater } = knownFor(args, dir, deps);
  const result = checkNotesTree(dir, known, { journalHighWater });
  for (const warning of result.warnings) deps.io.out(`warning: ${warning}`);
  if (result.errors.length > 0) {
    deps.io.err(
      `${dir}: ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} (known people from ${known.source}):`,
    );
    for (const error of result.errors) deps.io.err(`  - ${error}`);
    return 1;
  }
  const summary = result.load?.ok ? result.load.summary : undefined;
  deps.io.out(
    `${dir}: OK (known people from ${known.source}). It would load ${counted(summary?.people ?? 0, 'person', 'people')}, ${counted(summary?.groupTopics ?? 0, 'group topic')} and ${counted(summary?.circles ?? 0, 'circle')}, and start the dreams after journal #${summary?.watermark ?? 0}.`,
  );
  return 0;
}

async function observationsCommand(args: Args, deps: CliDeps): Promise<number> {
  const workDir = args.positional[0] ?? DEFAULT_WORK_DIR;
  // A wrong path must never look like an empty log: the views would be rebuilt empty (in a stray folder)
  // and the command would still succeed.
  if (!fs.statSync(path.join(workDir, 'observations'), { throwIfNoEntry: false })?.isDirectory()) {
    deps.io.err(
      `${path.resolve(workDir)} has no observations/ folder: that is not the playbook's work folder (the default is ${DEFAULT_WORK_DIR}). Nothing was written.`,
    );
    return 1;
  }
  const peopleFile = stringFlag(args, 'people') ?? path.join(workDir, '..', 'export', 'people.json');
  let known: ReadonlySet<string> | undefined;
  if (fs.existsSync(peopleFile)) {
    const read = knownPeopleFromJson(peopleFile);
    if (!read.ok) throw new UsageError(read.error);
    known = new Set(read.known.names.keys());
  } else {
    deps.io.out(`warning: ${peopleFile} not found: ids are checked for shape only`);
  }
  const result = splitObservations(workDir, known);
  const cast = writeCastSheet(workDir);
  deps.io.out(
    `${counted(result.observations, 'observation')} in ${counted(result.files, 'file')} → by-person/ (${counted(result.people.length, 'person', 'people')}${result.group ? ' + group' : ''}), by-circle/ (${counted(result.circles.length, 'circle')}); cast.md (${counted(cast, 'profile')})`,
  );
  for (const error of result.errors) deps.io.err(`  - ${error}`);
  return result.errors.length > 0 ? 1 : 0;
}

async function bootstrapCommand(args: Args, deps: CliDeps): Promise<number> {
  const dryRun = args.flags.has('dry-run');
  const run = args.flags.has('run');
  if (dryRun === run) throw new UsageError('bootstrap needs exactly one of --dry-run or --run');
  const stores = (deps.openStores ?? (() => openDataStores(deps.dataDir ?? DEFAULT_DATA_DIR)))();
  const from = monthFlag(args, 'from');
  const to = monthFlag(args, 'to');
  const model = config.dream.bootstrapModel;
  const priceOf = deps.priceOf ?? (async () => undefined);

  const progress = readProgress(stores.memory);
  const size = resolveSegmentTokens(progress, intFlag(args, 'segment-tokens', 1_000));
  if (!size.ok) throw new UsageError(size.error);
  const segmentTokens = size.value;
  const plan = planBootstrap(stores.archive, stores.memory, { segmentTokens, from, to });
  const estimate = estimateBootstrap(plan, {
    model,
    pricing: await priceOf(model),
    dreamModel: config.dream.model,
    dreamPricing: await priceOf(config.dream.model),
    done: new Set(progress?.done ?? []),
  });
  for (const line of describeEstimate(estimate)) deps.io.out(line);
  if (progress) {
    deps.io.out(
      `A run is under way: ${counted(progress.done.length, 'segment')} done so far (${counted(progress.rows, 'journal row')}, ${formatUsd(progress.costUsd)}).`,
    );
  }
  if (!checkHistoryImport(stores.archive, deps, 'The bootstrap', run)) return 1;
  if (dryRun) return 0;

  const client = (deps.client ?? (() => undefined))();
  if (!client) {
    deps.io.err('OPENROUTER_API_KEY is not set: --run needs it.');
    return 1;
  }
  const result = await runBootstrap({
    ...stores,
    client,
    model,
    from,
    to,
    segmentTokens,
    maxSegments: intFlag(args, 'max-segments', 1),
    now: deps.now,
    log: (line) => deps.io.out(line),
    ...(args.flags.has('no-dream') || !deps.dream
      ? {}
      : { dream: () => (deps.dream as NonNullable<CliDeps['dream']>)(stores, client) }),
  });
  deps.io.out(
    `Done: ${counted(result.segmentsDone, 'segment')} read, ${counted(result.rows, 'journal row')}, ${formatUsd(result.costUsd)}; ${result.segmentsLeft} left${result.segmentsFailed > 0 ? ` (${result.segmentsFailed} failed: run it again to retry them)` : ''}.`,
  );
  if (result.dream && 'error' in result.dream)
    deps.io.err(`The dream did not run: ${result.dream.error}. The nightly dream will pick the journal up.`);
  else if (result.dream) {
    const updated = new Set(
      result.dream.people.flatMap((p) =>
        p.status === 'updated' && p.owner.scope === 'person' ? [p.owner.ownerId] : [],
      ),
    ).size;
    const failed = new Set(
      result.dream.people.flatMap((p) =>
        p.status === 'failed' && p.owner.scope === 'person' ? [p.owner.ownerId] : [],
      ),
    ).size;
    const left =
      'caughtUp' in result.dream && result.dream.caughtUp === false
        ? ' Some journal rows are still waiting: the nightly dream picks them up.'
        : '';
    deps.io.out(
      `Dreamed: ${counted(updated, 'person', 'people')} updated${failed > 0 ? `, ${failed} failed` : ''}${result.dream.group?.status === 'updated' ? ', the group updated' : ''}${result.dream.costUsd !== undefined ? `, ${formatUsd(result.dream.costUsd)}` : ''}.${left}`,
    );
  }
  if (result.rows > 0) {
    // The bot keeps its journal's search vectors in memory, write-through for its own writes only.
    deps.io.out(
      'The running bot does not see these rows in its memory searches until it restarts: restart it (docker restart frigidaire-bot) once the run is done.',
    );
  }
  return result.segmentsFailed > 0 ? 1 : 0;
}

/** The holder label of the archive command's dream lease (what the bot's scheduler logs while it waits). */
export const ARCHIVE_HOLDER = 'the memory archive command (CLI)';

/**
 * The circle or occasion a slug names: `circle:<slug>` / `occasion:<slug>`, or a bare slug that only one of
 * them has. An error line otherwise.
 */
function findArchiveTarget(notes: NotesStore, raw: string): { note: Note } | { error: string } {
  const [kind, rest] = raw.includes(':') ? raw.split(/:(.*)/s, 2) : [undefined, raw];
  const slug = normalizeTopic(rest);
  if (!slug || (kind !== undefined && kind !== 'circle' && kind !== 'occasion')) {
    return { error: `"${raw}" is not a slug (or circle:<slug> / occasion:<slug>)` };
  }
  const circle = kind === 'occasion' ? undefined : notes.getCircle(slug);
  const occasion = kind === 'circle' ? undefined : notes.getOccasion(slug);
  if (circle && occasion) {
    return { error: `"${slug}" is both a circle and an occasion: say circle:${slug} or occasion:${slug}` };
  }
  const note = circle ?? occasion;
  return note ? { note } : { error: `there is no ${kind ?? 'circle or occasion'} "${slug}"` };
}

/** One line on what archiving a note does: `circle yugioh "The Yu-Gi-Oh crew": 3 members (2 current, …)`. */
function describeArchive(note: Note, month: string): string {
  const current = note.members.filter((m) => m.until === null).length;
  const people =
    note.scope === 'circle'
      ? `${counted(note.members.length, 'member')}${current > 0 ? ` (${current} current: their memberships end ${month})` : ''}`
      : counted(note.members.length, 'participant');
  return `${note.scope} ${note.topic} "${note.title}": ${people}; ${formatCount(note.content.length)} characters → a trace of ≤ ${formatCount(NOTE_LIMITS.archivedTargetChars)}`;
}

/**
 * `archive <slug>… [--dry-run]`: the owner's one-off archiving, through the nightly lifecycle pass's own
 * code path (dreamer.ts archiveShared: one compaction call each, NotesStore.archiveNote: status archived, a
 * circle's current memberships ended). Every slug must name a circle or an occasion, or nothing is archived
 * (a typo never half-runs). Already archived notes that are short enough are skipped. Holds the dream lease
 * while it runs, like `bootstrap --run`: not alongside the bot's nightly dream.
 */
async function archiveCommand(args: Args, deps: CliDeps): Promise<number> {
  if (args.positional.length === 0) throw new UsageError('archive needs at least one circle or occasion slug');
  const dryRun = args.flags.has('dry-run');
  const stores = (deps.openStores ?? (() => openDataStores(deps.dataDir ?? DEFAULT_DATA_DIR)))();
  const month = stores.notes.today().slice(0, 7);
  const targets: Note[] = [];
  const errors: string[] = [];
  for (const raw of [...new Set(args.positional)]) {
    const found = findArchiveTarget(stores.notes, raw);
    if ('error' in found) errors.push(found.error);
    else if (targets.some((t) => t.id === found.note.id)) continue;
    else if (isArchived(found.note) && found.note.content.length <= NOTE_LIMITS.archivedMaxChars) {
      deps.io.out(`${found.note.scope} ${found.note.topic} is already archived: skipped.`);
    } else targets.push(found.note);
  }
  if (errors.length > 0) {
    deps.io.err(`Nothing archived: ${errors.join('; ')}.`);
    return 1;
  }
  if (targets.length === 0) {
    deps.io.out('Nothing to archive.');
    return 0;
  }
  deps.io.out(`${dryRun ? 'Would archive' : 'Archiving'} ${counted(targets.length, 'note')}:`);
  for (const note of targets) deps.io.out(`  - ${describeArchive(note, month)}`);
  if (dryRun) return 0;

  const client = (deps.client ?? (() => undefined))();
  if (!client) {
    deps.io.err('OPENROUTER_API_KEY is not set: archiving compacts each note with the dream model.');
    return 1;
  }
  const taken = takeDreamLease(stores.memory, ARCHIVE_HOLDER);
  if (!taken.ok) {
    deps.io.err(
      `${taken.heldBy.holder} has been running since ${taken.heldBy.since} (Eastern): nothing archived. Run this again once it is done.`,
    );
    return 1;
  }
  const outcomes: LifecycleOutcome[] = [];
  try {
    for (const note of targets) {
      const why = isArchived(note) ? 'compact' : 'requested';
      const outcome = await archiveShared(note, why, {
        notes: stores.notes,
        memory: stores.memory,
        client,
        ...(deps.now ? { now: deps.now } : {}),
      });
      outcomes.push(outcome);
      if (outcome.status === 'archived') {
        deps.io.out(
          `  ✓ ${note.scope} ${note.topic}: archived (${formatCount(outcome.note.content.length)} characters).`,
        );
      } else if (outcome.status === 'failed') {
        deps.io.err(`  ✖ ${note.scope} ${note.topic}: ${outcome.error}`);
      }
    }
  } finally {
    taken.lease.release();
  }
  const done = outcomes.filter((o) => o.status === 'archived').length;
  const failed = outcomes.length - done;
  const cost = outcomes.reduce((sum, o) => sum + (o.costUsd ?? 0), 0);
  deps.io.out(
    `Done: ${counted(done, 'note')} archived${failed > 0 ? `, ${failed} failed (run it again to retry them)` : ''}, ${formatUsd(cost)}. Undo is in the notes viewer ("What does Fridge know?").`,
  );
  return failed > 0 ? 1 : 0;
}

export { parseActivitySeed } from '../notes/lifecycle';

/** `present (R 0.82)`, `fading (R 0.31) · yearly (usually Feb)`, `archive tonight (R 0.04)`. */
function describePresence(circle: Note, series: ActivityMonth[], today: string): string {
  const presence = circlePresence(circle, series, today);
  const state = presence.state === 'archive' ? 'archived tonight' : presence.state;
  const r = presence.r !== undefined ? ` (R ${presence.r.toFixed(2)})` : ' (no activity: by membership)';
  const cadence = yearlyCadence(series);
  return `${state}${r}${cadence ? ` · ${cadence.label}` : ''}`;
}

/**
 * `seed-activity <file.json> [--dry-run]`: records circles' monthly activity computed from the archive (the
 * decay's starting point: lifecycle.ts CIRCLE_DECAY), raising each month to its weight (idempotent). A file
 * that doesn't parse is refused whole; a slug that names no circle is skipped with a warning. Seeding never
 * brings an archived circle back (old months are history). Says how each circle stands afterwards.
 */
async function seedActivityCommand(args: Args, deps: CliDeps): Promise<number> {
  const file = args.positional[0];
  if (!file || args.positional.length > 1) throw new UsageError('seed-activity needs exactly one JSON file');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    deps.io.err(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const parsed = parseActivitySeed(raw, easternToday((deps.now ?? (() => new Date()))()));
  if (!parsed.ok) {
    deps.io.err(`${file}: nothing seeded, ${counted(parsed.errors.length, 'problem')}:`);
    for (const error of parsed.errors) deps.io.err(`  - ${error}`);
    return 1;
  }
  const dryRun = args.flags.has('dry-run');
  const stores = (deps.openStores ?? (() => openDataStores(deps.dataDir ?? DEFAULT_DATA_DIR)))();
  const today = stores.notes.today();
  const unknown: string[] = [];
  let seeded = 0;
  for (const [slug, months] of parsed.seed) {
    const circle = stores.notes.getCircle(slug);
    if (!circle) {
      unknown.push(slug);
      continue;
    }
    const merged = new Map(stores.notes.activityOf(circle.id).map((m) => [m.month, m]));
    for (const [month, weight] of Object.entries(months)) {
      const seen = merged.get(month);
      merged.set(month, { ...seen, month, weight: Math.max(seen?.weight ?? 0, weight) });
    }
    if (!dryRun) {
      const result = stores.notes.recordActivity(circle.id, months, { mode: 'max', revive: false });
      if (!result.ok) {
        deps.io.err(`  ✖ ${slug}: ${result.error}`);
        continue;
      }
    }
    seeded++;
    const keys = Object.keys(months).sort();
    const total = Object.values(months).reduce((sum, w) => sum + w, 0);
    const span = keys.length > 0 ? `${keys[0]} → ${keys[keys.length - 1]}` : 'none';
    const state = isArchived(circle)
      ? 'archived (stays archived)'
      : describePresence(circle, [...merged.values()], today);
    deps.io.out(`  - ${slug}: ${counted(keys.length, 'month')} (${span}), weight ${formatCount(total)} → ${state}`);
  }
  if (unknown.length > 0) deps.io.out(`warning: no circle ${unknown.join(', ')}: skipped.`);
  deps.io.out(
    `${dryRun ? 'Would seed' : 'Seeded'} ${counted(seeded, 'circle')}.${dryRun ? '' : " Circles due for archiving are archived by tonight's dream (10 a night, the faintest first)."}`,
  );
  return 0;
}

/** SQLite's "database is locked" (better-sqlite3 waits its 5-second busy timeout first). */
function isBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'));
}

/** Runs one command line; resolves to the exit code. A database another process keeps locked fails cleanly. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    switch (command) {
      case 'export':
        return await exportCommand(args, deps);
      case 'import':
        return await importCommand(args, deps);
      case 'observations':
        return await observationsCommand(args, deps);
      case 'bootstrap':
        return await bootstrapCommand(args, deps);
      case 'archive':
        return await archiveCommand(args, deps);
      case 'seed-activity':
        return await seedActivityCommand(args, deps);
      case undefined:
      case 'help':
      case '--help':
        deps.io.out(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.io.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (isBusyError(error)) {
      deps.io.err(
        'failed: the database is busy (another process, the bot or a second command, kept it locked past the 5-second wait). Nothing was changed: run it again in a moment.',
      );
      return 1;
    }
    deps.io.err(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 1;
  }
}
