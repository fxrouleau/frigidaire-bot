// The deleted-message repost's eval set: messages labelled "should the edgy judge let this repost through?".
// `yarn eval:deleted-repost` (runEval.ts) runs them live through the real pipeline: the uploads saved as the
// reposter saves them, describeForJudge (Discord attachment links signed, GIFs opened and sampled, GIF pages
// read), then the edgy judge. cases.test.ts validates the format offline.
//
// The cases are real messages from the server, so they live only in the gitignored
// data/deleted-repost-cases.json (or in files passed as arguments). This repo is public: no case, link or
// description of one is ever committed, and the eval's result file keeps case ids and file names only.
//
// File format:
//   {
//     "version": 1,
//     "cases": [
//       {
//         "id": "gif-1",          // unique across every file: 1–64 letters, digits, '.', '_', '-'
//         "label": true,          // true = edgy: the judge should repost it; false = harmless, left deleted
//         "text": "https://cdn.discordapp.com/attachments/<channel>/<attachment>/<name>.gif",
//                                 // the message text exactly as posted ("" when it was only uploads)
//         "files": [              // optional, 1–10: uploads, saved the way the reposter saves them
//           { "url": "https://cdn.discordapp.com/attachments/<channel>/<attachment>/clip.mp4",
//             "name": "clip.mp4", "contentType": "video/mp4" }   // contentType optional, as Discord sends it
//         ],
//         "author": "Robin",      // optional: the display name the judge is told (default DEFAULT_AUTHOR)
//         "note": "why"           // optional: printed only with --show, never written to the result file
//       }
//     ]
//   }
//
// Also here, so they are tested offline: the CLI's arguments, how a run is scored, and the redaction of the
// judge's log lines (what it says a GIF shows is private content).
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The display name the judge is told when a case names none (prod passes the member's). */
export const DEFAULT_AUTHOR = 'Robin';
// Discord's limits: a Nitro member's message length, attachments per message.
const MAX_TEXT_CHARS = 4000;
const MAX_FILES = 10;
const MAX_NAME_CHARS = 200;
const MAX_AUTHOR_CHARS = 80;
export const MAX_REPEATS = 20;
// Ids and file names go into the result file and the console: a link can't hide in either.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:\s*;.*)?$/i;

/** An upload: where to download it from, and what Discord called it. */
export type EvalUpload = { url: string; name: string; contentType?: string };

export type DeletedRepostCase = {
  id: string;
  label: boolean;
  text: string;
  files?: EvalUpload[];
  author?: string;
  note?: string;
};

const FILE_KEYS = new Set(['version', 'cases']);
const CASE_KEYS = new Set(['id', 'label', 'text', 'files', 'author', 'note']);
const UPLOAD_KEYS = new Set(['url', 'name', 'contentType']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateUpload(upload: unknown, where: string, errors: string[]): void {
  if (!isRecord(upload)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const extra = unknownKeys(upload, UPLOAD_KEYS);
  if (extra.length > 0) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
  if (!isHttpUrl(upload.url)) errors.push(`${where}.url: must be an http(s) link`);
  const name = upload.name;
  if (!nonEmptyString(name) || name.length > MAX_NAME_CHARS || /[/\\]/.test(name)) {
    errors.push(`${where}.name: must be a file name (no slashes, at most ${MAX_NAME_CHARS} characters)`);
  }
  if (
    upload.contentType !== undefined &&
    !(typeof upload.contentType === 'string' && CONTENT_TYPE.test(upload.contentType))
  ) {
    errors.push(`${where}.contentType: must be a media type like "image/gif"`);
  }
}

function validateCase(entry: unknown, where: string, seen: Set<string>, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const extra = unknownKeys(entry, CASE_KEYS);
  if (extra.length > 0) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
    errors.push(`${where}.id: must be 1–64 letters, digits, '.', '_' or '-' (it goes into the result file)`);
  } else if (seen.has(entry.id)) {
    errors.push(`${where}.id: duplicate id "${entry.id}"`);
  } else {
    seen.add(entry.id);
  }
  if (typeof entry.label !== 'boolean') errors.push(`${where}.label: must be true (edgy) or false`);
  if (typeof entry.text !== 'string') {
    errors.push(`${where}.text: must be a string (the message text exactly as posted, "" for uploads only)`);
  } else if (entry.text.length > MAX_TEXT_CHARS) {
    errors.push(`${where}.text: longer than a Discord message (${MAX_TEXT_CHARS} characters)`);
  }
  if (entry.files !== undefined) {
    if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > MAX_FILES) {
      errors.push(`${where}.files: must be a list of 1–${MAX_FILES} uploads (leave it out for none)`);
    } else {
      entry.files.forEach((upload: unknown, i: number) => {
        validateUpload(upload, `${where}.files[${i}]`, errors);
      });
    }
  }
  const hasFiles = Array.isArray(entry.files) && entry.files.length > 0;
  if (typeof entry.text === 'string' && entry.text.trim().length === 0 && !hasFiles) {
    errors.push(`${where}: no text and no files, nothing to judge`);
  }
  const author = entry.author;
  if (author !== undefined && !(nonEmptyString(author) && author.length <= MAX_AUTHOR_CHARS)) {
    errors.push(`${where}.author: must be a name of at most ${MAX_AUTHOR_CHARS} characters`);
  }
  if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`${where}.note: must be a string`);
}

/** Validates a parsed case file. Unknown fields are errors, so a typo can't silently change a case. */
export function validateCaseFile(raw: unknown, source: string): { cases: DeletedRepostCase[]; errors: string[] } {
  if (!isRecord(raw)) return { cases: [], errors: [`${source}: the file must be a JSON object`] };
  const errors: string[] = [];
  const extra = unknownKeys(raw, FILE_KEYS);
  if (extra.length > 0) errors.push(`${source}: unknown field(s) ${extra.join(', ')}`);
  if (raw.version !== 1) errors.push(`${source}: "version" must be 1`);
  if (!Array.isArray(raw.cases)) return { cases: [], errors: [...errors, `${source}: "cases" must be an array`] };

  const seen = new Set<string>();
  raw.cases.forEach((entry: unknown, index: number) => {
    validateCase(entry, `${source} cases[${index}]`, seen, errors);
  });
  return { cases: errors.length === 0 ? (raw.cases as DeletedRepostCase[]) : [], errors };
}

/** Reads and validates a case file; throws with every problem listed. */
export function loadCaseFile(filePath: string): DeletedRepostCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath}: not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const { cases, errors } = validateCaseFile(parsed, path.basename(filePath));
  if (errors.length > 0) throw new Error(`${filePath} is invalid:\n  ${errors.join('\n  ')}`);
  return cases;
}

export type SourcedCase = { source: string; case: DeletedRepostCase };

/** Loads several case files in order; a case id must be unique across all of them. */
export function loadCaseSources(filePaths: string[]): SourcedCase[] {
  const cases: SourcedCase[] = [];
  const seen = new Map<string, string>();
  for (const filePath of filePaths) {
    const source = path.basename(filePath);
    for (const c of loadCaseFile(filePath)) {
      const clash = seen.get(c.id);
      if (clash) throw new Error(`Duplicate case id "${c.id}" in ${source} (also in ${clash})`);
      seen.set(c.id, source);
      cases.push({ source, case: c });
    }
  }
  return cases;
}

// ---- The CLI's arguments ----

export const USAGE = 'usage: yarn eval:deleted-repost [--repeats N] [--show] [cases.json ...]';

export type EvalArgs = {
  /** Judge calls per case and model (verdicts at temperature 0 still vary between calls). */
  repeats: number;
  /** Print what the judge saw and said: private content, off by default. */
  show: boolean;
  /** Case files besides data/deleted-repost-cases.json. */
  files: string[];
};

export function parseEvalArgs(args: string[]): EvalArgs | { error: string } {
  const parsed: EvalArgs = { repeats: 1, show: false, files: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--show') {
      parsed.show = true;
    } else if (arg === '--repeats' || arg.startsWith('--repeats=')) {
      let value = arg.slice('--repeats='.length);
      if (arg === '--repeats') {
        i += 1;
        value = args[i] ?? '';
      }
      const repeats = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
      if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
        return { error: `--repeats takes a whole number from 1 to ${MAX_REPEATS}` };
      }
      parsed.repeats = repeats;
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` };
    } else {
      parsed.files.push(arg);
    }
  }
  return parsed;
}

// ---- Scoring ----

/**
 * One judge call's outcome: `not_judged` when the reposter would not have asked (nothing to repost, or only
 * links it couldn't open: it leaves those deleted), `no_verdict` when no backend answered.
 */
export type Judgment = 'edgy' | 'not_edgy' | 'no_verdict' | 'not_judged';

/** A case's judgments by one model; `pipelineFailed`: it had media and none of it could be opened. */
export type CaseRun = { id: string; label: boolean; pipelineFailed: boolean; judgments: Judgment[] };

/** Counts are judge calls (cases × repeats), except `pipelineFailures` (cases). */
export type ModelScore = {
  model: string;
  positives: number;
  caught: number;
  /** Not edgy, though the judge saw what the message showed. */
  judgeMisses: number;
  /** Not edgy (or not asked) because nothing the message showed could be opened. */
  pipelineMisses: number;
  /** No verdict: prod leaves the message deleted. */
  noVerdict: number;
  negatives: number;
  falsePositives: number;
  pipelineFailures: number;
  /** caught / positives, end to end; undefined without positives. */
  recall?: number;
  /** Recall over the edgy cases whose media opened: the judge's own share. */
  judgeRecall?: number;
  falsePositiveRate?: number;
  /** Every edgy case caught on every call, nothing harmless reposted, every case's media opened. */
  pass: boolean;
};

function ratio(part: number, whole: number): number | undefined {
  return whole > 0 ? part / whole : undefined;
}

export function scoreRuns(model: string, runs: CaseRun[]): ModelScore {
  const n = { positives: 0, caught: 0, judgeMisses: 0, pipelineMisses: 0, noVerdict: 0, negatives: 0, fp: 0 };
  let openedPositives = 0;
  let openedCaught = 0;
  for (const run of runs) {
    for (const judgment of run.judgments) {
      if (!run.label) {
        n.negatives += 1;
        if (judgment === 'edgy') n.fp += 1;
        continue;
      }
      n.positives += 1;
      if (!run.pipelineFailed) {
        openedPositives += 1;
        if (judgment === 'edgy') openedCaught += 1;
      }
      if (judgment === 'edgy') n.caught += 1;
      else if (run.pipelineFailed) n.pipelineMisses += 1;
      else if (judgment === 'not_edgy') n.judgeMisses += 1;
      else n.noVerdict += 1;
    }
  }
  const pipelineFailures = runs.filter((run) => run.pipelineFailed).length;
  return {
    model,
    positives: n.positives,
    caught: n.caught,
    judgeMisses: n.judgeMisses,
    pipelineMisses: n.pipelineMisses,
    noVerdict: n.noVerdict,
    negatives: n.negatives,
    falsePositives: n.fp,
    pipelineFailures,
    recall: ratio(n.caught, n.positives),
    judgeRecall: ratio(openedCaught, openedPositives),
    falsePositiveRate: ratio(n.fp, n.negatives),
    pass: n.caught === n.positives && n.fp === 0 && pipelineFailures === 0,
  };
}

/** One character per judge call, for the table: Y edgy, n not edgy, ? no verdict, - not asked. */
export function judgmentMark(judgment: Judgment): string {
  return { edgy: 'Y', not_edgy: 'n', no_verdict: '?', not_judged: '-' }[judgment];
}

// ---- The judge's log lines ----

/**
 * A log line with what the judge said a message showed taken out (messageJudge.ts logs its "shows" sentence,
 * and its raw answer when it has no verdict): the GIFs are private, so the eval prints that only with --show.
 */
export function redactJudgeLine(message: string): string {
  if (!message.startsWith('messageJudge:')) return message;
  return message
    .replace(/ \(shows: [\s\S]*\)$/, ' (shows: hidden, pass --show)')
    .replace(/(returned no verdict \(finish=[^)]*\)):[\s\S]*$/, '$1: (answer hidden, pass --show)');
}
