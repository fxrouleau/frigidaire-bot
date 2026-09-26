// The Claude Code playbook's observation log (.claude/skills/memory-bootstrap/SKILL.md): each scan step
// appends dated observations to observations/NNNN.jsonl, one JSON object per line, and nothing ever
// rewrites them. This helper is the deterministic bookkeeping around that log, so the playbook's
// orchestrator never has to read it: it validates every line, then rebuilds by-person/<id>.jsonl (a
// person's own observations plus every relationship or shared event that names them, from either side),
// by-person/group.jsonl, by-circle/<slug>.jsonl, and by-person/index.json (counts, estimated tokens and
// the dated span per person, which decide when a person's final build goes hierarchical).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeTopic } from '../notes/schema';
import { estimateTokens } from './tokens';

/** One observation line as the scan writes it. */
export type Observation = {
  /** Main ids of the people involved (one, or several for a relationship or shared event), or ["group"]. */
  people: string[];
  category: (typeof OBSERVATION_CATEGORIES)[number];
  kind: (typeof OBSERVATION_KINDS)[number];
  content: string;
  /** YYYY-MM or YYYY-MM-DD. */
  date: string;
  confidence?: number;
  /** Where in the export it was seen: chunk id and its line range. */
  evidence: { chunk: string; lines: [number, number] }[];
  quote?: string;
  /** The circle (interest group, sub-group, or a pair's history) it belongs to, when there is one. */
  circle?: string;
};

export const OBSERVATION_CATEGORIES = ['fact', 'preference', 'personality', 'event', 'vibe'] as const;
export const OBSERVATION_KINDS = ['trait', 'fact', 'event', 'joke', 'relationship', 'history'] as const;
const GROUP = 'group';
const DATE = /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/;
const SNOWFLAKE = /^\d{15,21}$/;
const MAX_CONTENT_CHARS = 600;
const MAX_QUOTE_CHARS = 300;

/** A line's problems, or the observation. `known` = main ids people.json lists (undefined: shape only). */
export function validateObservation(
  raw: unknown,
  known?: ReadonlySet<string>,
): { ok: true; value: Observation } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['not a JSON object'] };
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];

  const people = Array.isArray(o.people) ? o.people.filter((p): p is string => typeof p === 'string') : [];
  if (people.length === 0 || people.length !== (o.people as unknown[]).length) {
    errors.push('"people" must be a non-empty array of main ids, or ["group"]');
  } else if (people.includes(GROUP) && people.length > 1) {
    errors.push('"people" is either ["group"] or member ids, not both');
  } else {
    for (const id of people) {
      if (id === GROUP) continue;
      if (!SNOWFLAKE.test(id)) errors.push(`"people" entry "${id.slice(0, 30)}" is not a Discord id`);
      else if (known && !known.has(id)) errors.push(`"people" entry ${id} is not a main id in people.json`);
    }
  }
  const category = OBSERVATION_CATEGORIES.find((c) => c === o.category);
  if (!category) errors.push(`"category" must be one of ${OBSERVATION_CATEGORIES.join(', ')}`);
  const kind = OBSERVATION_KINDS.find((k) => k === o.kind);
  if (!kind) errors.push(`"kind" must be one of ${OBSERVATION_KINDS.join(', ')}`);
  const content = typeof o.content === 'string' ? o.content.trim() : '';
  if (!content) errors.push('"content" is missing');
  else if (content.length > MAX_CONTENT_CHARS) errors.push(`"content" is over ${MAX_CONTENT_CHARS} characters`);
  const date = typeof o.date === 'string' ? o.date.trim() : '';
  if (!DATE.test(date)) errors.push('"date" must be YYYY-MM or YYYY-MM-DD');
  if (o.confidence !== undefined && (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1)) {
    errors.push('"confidence" must be a number from 0 to 1');
  }
  const evidence: Observation['evidence'] = [];
  if (!Array.isArray(o.evidence) || o.evidence.length === 0) {
    errors.push('"evidence" must list at least one {"chunk": "NNNN", "lines": [from, to]}');
  } else {
    for (const entry of o.evidence) {
      const e = (entry ?? {}) as { chunk?: unknown; lines?: unknown };
      const lines = Array.isArray(e.lines) ? e.lines : [];
      const [from, to] = lines;
      if (
        typeof e.chunk !== 'string' ||
        !/^\d{4}$/.test(e.chunk) ||
        lines.length !== 2 ||
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        (from as number) < 1 ||
        (to as number) < (from as number)
      ) {
        errors.push('an "evidence" entry must be {"chunk": "NNNN", "lines": [from, to]} with 1 ≤ from ≤ to');
      } else {
        evidence.push({ chunk: e.chunk, lines: [from as number, to as number] });
      }
    }
  }
  if (o.quote !== undefined && (typeof o.quote !== 'string' || o.quote.length > MAX_QUOTE_CHARS)) {
    errors.push(`"quote" must be text up to ${MAX_QUOTE_CHARS} characters`);
  }
  let circle: string | undefined;
  if (o.circle !== undefined && o.circle !== null && o.circle !== '') {
    circle = normalizeTopic(o.circle);
    if (!circle) errors.push('"circle" must be a lowercase slug (letters, digits, single hyphens)');
  }

  if (errors.length > 0 || !category || !kind) return { ok: false, errors };
  return {
    ok: true,
    value: {
      people,
      category,
      kind,
      content,
      date,
      ...(typeof o.confidence === 'number' ? { confidence: o.confidence } : {}),
      evidence,
      ...(typeof o.quote === 'string' ? { quote: o.quote } : {}),
      ...(circle ? { circle } : {}),
    },
  };
}

export type ObservationIndexEntry = {
  /** A main id, or "group". */
  owner: string;
  observations: number;
  tokens: number;
  first: string;
  last: string;
};

export type SplitResult = {
  /** Valid observations read, over every file. */
  observations: number;
  files: number;
  /** `observations/NNNN.jsonl:12: problem` */
  errors: string[];
  people: ObservationIndexEntry[];
  group?: ObservationIndexEntry;
  circles: ObservationIndexEntry[];
};

/** Date order (a month sorts before its days), then the chunk and line it was seen at. */
function byDate(a: Observation, b: Observation): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ea = a.evidence[0];
  const eb = b.evidence[0];
  if (ea.chunk !== eb.chunk) return ea.chunk < eb.chunk ? -1 : 1;
  return ea.lines[0] - eb.lines[0];
}

function writeLog(file: string, observations: Observation[]): ObservationIndexEntry & { text: string } {
  const sorted = [...observations].sort(byDate);
  const text = sorted.map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(file, text ? `${text}\n` : '');
  return {
    owner: path.basename(file, '.jsonl'),
    observations: sorted.length,
    tokens: estimateTokens(text),
    first: sorted[0]?.date ?? '',
    last: sorted.at(-1)?.date ?? '',
    text,
  };
}

/**
 * Validates `<workDir>/observations/*.jsonl` and rebuilds the per-person, per-circle and group views (see
 * the file comment). Invalid lines are reported and left out of the views; the log itself is never touched.
 */
export function splitObservations(workDir: string, known?: ReadonlySet<string>): SplitResult {
  const source = path.join(workDir, 'observations');
  const files = fs.existsSync(source)
    ? fs
        .readdirSync(source)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
    : [];
  const errors: string[] = [];
  const byOwner = new Map<string, Observation[]>();
  const byCircle = new Map<string, Observation[]>();
  let count = 0;
  for (const file of files) {
    const lines = fs.readFileSync(path.join(source, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const where = `observations/${file}:${i + 1}`;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        errors.push(`${where}: not valid JSON`);
        return;
      }
      const result = validateObservation(raw, known);
      if (!result.ok) {
        errors.push(...result.errors.map((e) => `${where}: ${e}`));
        return;
      }
      count++;
      for (const owner of new Set(result.value.people)) {
        const list = byOwner.get(owner) ?? [];
        list.push(result.value);
        byOwner.set(owner, list);
      }
      if (result.value.circle) {
        const list = byCircle.get(result.value.circle) ?? [];
        list.push(result.value);
        byCircle.set(result.value.circle, list);
      }
    });
  }

  const personDir = path.join(workDir, 'by-person');
  const circleDir = path.join(workDir, 'by-circle');
  for (const dir of [personDir, circleDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const strip = ({ text: _text, ...entry }: ObservationIndexEntry & { text: string }) => entry;
  const people: ObservationIndexEntry[] = [];
  let group: ObservationIndexEntry | undefined;
  for (const [owner, list] of [...byOwner.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const entry = strip(writeLog(path.join(personDir, `${owner}.jsonl`), list));
    if (owner === GROUP) group = entry;
    else people.push(entry);
  }
  const circles = [...byCircle.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([slug, list]) => strip(writeLog(path.join(circleDir, `${slug}.jsonl`), list)));
  people.sort((a, b) => b.observations - a.observations);
  fs.writeFileSync(
    path.join(personDir, 'index.json'),
    `${JSON.stringify({ observations: count, files: files.length, people, group: group ?? null, circles }, null, 2)}\n`,
  );
  return { observations: count, files: files.length, errors, people, ...(group ? { group } : {}), circles };
}
