// The notes tree the bootstrap import loads (docs/memory.md "Bootstrap" §3): notes built outside the bot
// (the Claude Code playbook in .claude/skills/memory-bootstrap, or by hand) as markdown files.
//
//   manifest.json            {"format": "frigidaire-notes", "version": 1, "journal_high_water": <n>, …}
//   people/<main id>/profile.md      every person with notes has a profile
//   people/<main id>/<topic>.md      topic notes (games.md, work.md, …)
//   group/<topic>.md                 the group's notes (lore.md, running-jokes.md, vibe.md, …)
//   circles/<slug>.md                circles (mtg.md, remi-and-dale.md, …)
//   people.json                      optional: the export's people.json (check mode reads known ids from it)
//
// Each note is markdown under a small front matter block; values are plain text, or JSON when they start
// with [ { or ":
//
//   ---
//   title: The MTG crew
//   aliases: ["the drafters"]
//   members: [{"id": "100000000000000001", "since": "2021", "role": "organizer"}, {"id": "100000000000000002", "since": "2021", "until": "2023-02"}]
//   ---
//   ## Now
//   Friday drafts at the game store (since 2021, most weeks).
//
// This module only reads and parses: every problem is collected with the file it is in, so one check run
// lists everything to fix. The shape rules (slugs, sizes, markup) are schema.ts's, shared with every writer.
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type CircleDraft,
  NOTE_LIMITS,
  type NoteDraft,
  normalizeTopic,
  PROFILE_TOPIC,
  validateCircleDraft,
  validateNoteDraft,
} from '../notes/schema';

export const NOTES_TREE_FORMAT = 'frigidaire-notes';
export const NOTES_TREE_VERSION = 1;

/** A tree's manifest.json. */
export type NotesTreeManifest = {
  format: typeof NOTES_TREE_FORMAT;
  version: typeof NOTES_TREE_VERSION;
  /** The journal high-water mark of the export the notes were built from: the dreams' new watermark. */
  journal_high_water: number;
  [key: string]: unknown;
};

/** A parsed, shape-checked tree (store-level rules, known ids and limits across owners come at load). */
export type NotesTree = {
  dir: string;
  manifest: NotesTreeManifest;
  people: { id: string; notes: NoteDraft[] }[];
  /** undefined when the tree has no group/ folder (the group's notes are left alone). */
  group?: NoteDraft[];
  /** undefined when the tree has no circles/ folder (circles are left alone). */
  circles?: CircleDraft[];
};

export type NotesTreeRead = { ok: true; tree: NotesTree; warnings: string[] } | { ok: false; errors: string[] };

// Generous: the largest note is 8,000 characters of markdown plus a front matter with 30 members.
const MAX_FILE_BYTES = 64 * 1024;
const SNOWFLAKE = /^\d{15,21}$/;
const TOP_LEVEL = new Set(['manifest.json', 'people', 'group', 'circles', 'people.json', 'README.md']);

/** Whether a folder holds a notes tree waiting to be imported (a manifest.json at its root). */
export function hasNotesTree(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'manifest.json'));
}

type FrontMatter = { fields: Record<string, unknown>; body: string };

/**
 * Splits `---` front matter from a markdown body. Each front matter line is `key: value`; a value starting
 * with `[`, `{` or `"` is JSON, anything else plain text.
 */
export function parseFrontMatter(text: string): { ok: true; value: FrontMatter } | { ok: false; error: string } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { ok: false, error: 'must start with a front matter block (a "---" line)' };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { ok: false, error: 'the front matter block is never closed (a second "---" line)' };
  const fields: Record<string, unknown> = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) return { ok: false, error: `front matter line "${line.slice(0, 60)}" is not "key: value"` };
    const [, key, raw] = match;
    if (key in fields) return { ok: false, error: `front matter key "${key}" appears twice` };
    const value = raw.trim();
    if (/^[[{"]/.test(value)) {
      try {
        fields[key] = JSON.parse(value);
      } catch {
        return { ok: false, error: `front matter "${key}" is not valid JSON` };
      }
    } else {
      fields[key] = value;
    }
  }
  return {
    ok: true,
    value: {
      fields,
      body: lines
        .slice(end + 1)
        .join('\n')
        .trim(),
    },
  };
}

function readText(file: string, errors: string[], label: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      errors.push(`${label}: not a file`);
      return undefined;
    }
    if (stat.size > MAX_FILE_BYTES) {
      errors.push(`${label}: ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte limit for a note file`);
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    errors.push(`${label}: unreadable (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

function listDir(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

/** A `<slug>.md` file name's slug, or an error. */
function slugOf(name: string, label: string, errors: string[]): string | undefined {
  if (!name.endsWith('.md')) {
    errors.push(`${label}: only .md note files belong here`);
    return undefined;
  }
  const raw = name.slice(0, -3);
  const slug = normalizeTopic(raw);
  if (!slug || slug !== raw) {
    errors.push(
      `${label}: the file name must be a lowercase slug (letters, digits, single hyphens; ≤${NOTE_LIMITS.topicSlugMaxChars} chars) + .md`,
    );
    return undefined;
  }
  return slug;
}

const NOTE_KEYS = new Set(['title']);
const CIRCLE_KEYS = new Set(['title', 'aliases', 'members']);

function unknownKeys(fields: Record<string, unknown>, allowed: Set<string>, label: string, errors: string[]): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      errors.push(`${label}: unknown front matter key "${key}" (allowed: ${[...allowed].join(', ')})`);
    }
  }
}

/** One person or group note file (`ownId`: the person's own id, which their notes may mention). */
function readNote(
  file: string,
  label: string,
  scope: 'person' | 'group',
  errors: string[],
  ownId?: string,
): NoteDraft | undefined {
  const topic = slugOf(path.basename(file), label, errors);
  const text = readText(file, errors, label);
  if (!topic || text === undefined) return undefined;
  const parsed = parseFrontMatter(text);
  if (!parsed.ok) {
    errors.push(`${label}: ${parsed.error}`);
    return undefined;
  }
  unknownKeys(parsed.value.fields, NOTE_KEYS, label, errors);
  const result = validateNoteDraft(
    { topic, title: parsed.value.fields.title, content: parsed.value.body },
    { scope, allowedIds: ownId ? [ownId] : [] },
  );
  if (!result.ok) {
    errors.push(...result.errors.map((e) => `${label}: ${e}`));
    return undefined;
  }
  return result.value;
}

/** One circle file. */
function readCircle(file: string, label: string, errors: string[]): CircleDraft | undefined {
  const slug = slugOf(path.basename(file), label, errors);
  const text = readText(file, errors, label);
  if (!slug || text === undefined) return undefined;
  const parsed = parseFrontMatter(text);
  if (!parsed.ok) {
    errors.push(`${label}: ${parsed.error}`);
    return undefined;
  }
  const { fields, body } = parsed.value;
  unknownKeys(fields, CIRCLE_KEYS, label, errors);
  const result = validateCircleDraft({
    slug,
    title: fields.title,
    content: body,
    aliases: fields.aliases ?? [],
    members: fields.members,
    merged_from: [],
  });
  if (!result.ok) {
    errors.push(...result.errors.map((e) => `${label}: ${e}`));
    return undefined;
  }
  return result.value;
}

function readManifest(dir: string, errors: string[]): NotesTreeManifest | undefined {
  const text = readText(path.join(dir, 'manifest.json'), errors, 'manifest.json');
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    errors.push('manifest.json: not valid JSON');
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('manifest.json: must be a JSON object');
    return undefined;
  }
  const manifest = raw as Record<string, unknown>;
  const before = errors.length;
  if (manifest.format !== NOTES_TREE_FORMAT) errors.push(`manifest.json: "format" must be "${NOTES_TREE_FORMAT}"`);
  if (manifest.version !== NOTES_TREE_VERSION) errors.push(`manifest.json: "version" must be ${NOTES_TREE_VERSION}`);
  const mark = manifest.journal_high_water;
  if (typeof mark !== 'number' || !Number.isInteger(mark) || mark < 0) {
    errors.push(
      'manifest.json: "journal_high_water" must be a whole number ≥ 0 (copy it from the export\'s manifest.json)',
    );
  }
  return errors.length === before ? (manifest as NotesTreeManifest) : undefined;
}

/**
 * Reads and shape-checks a notes tree: the manifest, every note and circle file (front matter, slugs,
 * sizes, markdown only), a profile for every person, and the topic limits. Store-level rules (known
 * members, linked accounts, circle limits across the whole store) are checked when it is loaded.
 */
export function readNotesTree(dir: string): NotesTreeRead {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, errors: [`${dir} is not a folder`] };
  const manifest = readManifest(dir, errors);

  for (const entry of listDir(dir)) {
    if (!TOP_LEVEL.has(entry.name) && !entry.name.startsWith('imported-')) {
      warnings.push(`${entry.name}: not part of a notes tree, ignored`);
    }
  }

  const people: NotesTree['people'] = [];
  const peopleDir = path.join(dir, 'people');
  if (fs.existsSync(peopleDir)) {
    for (const entry of listDir(peopleDir)) {
      const label = `people/${entry.name}`;
      if (!entry.isDirectory()) {
        errors.push(`${label}: people/ holds one folder per person, named by their main account id`);
        continue;
      }
      if (!SNOWFLAKE.test(entry.name)) {
        errors.push(`${label}: a person's folder is named by their Discord id (their main account)`);
        continue;
      }
      const notes: NoteDraft[] = [];
      for (const file of listDir(path.join(peopleDir, entry.name))) {
        const notePath = path.join(peopleDir, entry.name, file.name);
        const note = readNote(notePath, `${label}/${file.name}`, 'person', errors, entry.name);
        if (note) notes.push(note);
      }
      if (!notes.some((n) => n.topic === PROFILE_TOPIC) && !errors.some((e) => e.startsWith(`${label}/profile.md`))) {
        errors.push(`${label}: every person needs a profile.md`);
      }
      if (notes.length > NOTE_LIMITS.maxPersonTopics) {
        errors.push(`${label}: ${notes.length} topics, over the limit of ${NOTE_LIMITS.maxPersonTopics}`);
      }
      people.push({ id: entry.name, notes });
    }
  }

  let group: NoteDraft[] | undefined;
  const groupDir = path.join(dir, 'group');
  if (fs.existsSync(groupDir)) {
    group = [];
    for (const file of listDir(groupDir)) {
      const note = readNote(path.join(groupDir, file.name), `group/${file.name}`, 'group', errors);
      if (note) group.push(note);
    }
    if (group.length > NOTE_LIMITS.maxGroupTopics) {
      errors.push(`group: ${group.length} topics, over the limit of ${NOTE_LIMITS.maxGroupTopics}`);
    }
  }

  let circles: CircleDraft[] | undefined;
  const circlesDir = path.join(dir, 'circles');
  if (fs.existsSync(circlesDir)) {
    circles = [];
    for (const file of listDir(circlesDir)) {
      const circle = readCircle(path.join(circlesDir, file.name), `circles/${file.name}`, errors);
      if (circle) circles.push(circle);
    }
    if (circles.length > NOTE_LIMITS.maxCircles) {
      errors.push(`circles: ${circles.length} circles, over the limit of ${NOTE_LIMITS.maxCircles}`);
    }
  }

  if (people.length === 0 && !group?.length && !circles?.length && errors.length === 0) {
    errors.push('the tree holds no notes (people/, group/ and circles/ are empty or missing)');
  }
  if (errors.length > 0 || !manifest) return { ok: false, errors };
  return { ok: true, tree: { dir, manifest, people, group, circles }, warnings };
}
