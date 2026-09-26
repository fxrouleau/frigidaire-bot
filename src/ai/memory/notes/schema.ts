// Memory v2 notes: the shapes and the validation every writer shares (the notes store, the nightly dream,
// owner edits, the bootstrap import and the built-in bootstrap). Notes are markdown written by a model or
// copied from files, so everything here treats them as untrusted input: a note that breaks a rule is
// refused whole (nothing is clamped into a different meaning), except the free-text change summary, which
// is only ever shown in a log or report line and is clamped. See docs/memory.md.

/** Whose notes: one member (by main account id) or the group as a whole. */
export type NoteScope = 'person' | 'group';

/** The owner of a set of notes. A person is always their MAIN account id (LINKED_ACCOUNTS resolved). */
export type NoteOwner = { scope: 'person'; ownerId: string } | { scope: 'group' };

/** Who wrote a note version. */
export const NOTE_WRITERS = ['dream', 'edit', 'bootstrap', 'import', 'undo'] as const;
export type NoteUpdatedBy = (typeof NOTE_WRITERS)[number];

/** Every person has this topic once they have notes at all: who they are, in ~200–400 words. */
export const PROFILE_TOPIC = 'profile';

/** Size limits, checked on every write. */
export const NOTE_LIMITS = {
  /** A person's profile. */
  profileMaxChars: 4_000,
  /** Any other topic (a person's or the group's). */
  topicMaxChars: 8_000,
  /** Topics per person, the profile included. */
  maxPersonTopics: 10,
  /** Topics for the group. */
  maxGroupTopics: 8,
  titleMaxChars: 80,
  topicSlugMaxChars: 32,
  /** The change summary a dream or an edit returns (clamped, never refused). */
  changeSummaryMaxChars: 300,
} as const;

/** One note as a writer proposes it. `content` is markdown. */
export type NoteDraft = { topic: string; title: string; content: string };

/**
 * What a dream, an owner edit and the bootstrap return for ONE owner (a person or the group), as JSON:
 * the notes to write (new or changed; unchanged ones may be repeated or left out), the topics to remove,
 * and a few words on what changed (for the report line and the version history).
 */
export type NotesOutput = {
  notes: NoteDraft[];
  removed_topics: string[];
  change_summary: string;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type NoteValidationContext = {
  scope: NoteScope;
  /**
   * Discord ids that may appear in note text: the person's own account ids and ids that were in the
   * writer's input. Any other 15–21 digit number is refused (a model copying someone else's id).
   */
  allowedIds?: Iterable<string>;
};

/** Lowercase words joined by single hyphens: `profile`, `games`, `running-jokes`. */
export const TOPIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Discord markup a note must never carry: it would ping, render as an emoji or a timestamp, or link a
// channel when a note is quoted into a message. Notes describe emoji style in words.
const DISCORD_MARKUP: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /<@[!&]?\d+>/, what: 'a Discord mention' },
  { pattern: /<#\d+>/, what: 'a channel mention' },
  { pattern: /<a?:\w+:\d+>/, what: 'custom emoji syntax' },
  { pattern: /<t:-?\d+(?::[a-zA-Z])?>/, what: 'a Discord timestamp' },
  { pattern: /<\/[\w -]+:\d+>/, what: 'a slash-command mention' },
  { pattern: /@(?:everyone|here)\b/i, what: '@everyone/@here' },
];
// Raw HTML (markdown only). `<https://…>` autolinks and "<3" are not tags.
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;
// Control characters other than tab and newline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to find control characters.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SNOWFLAKE_LIKE = /\b\d{15,21}\b/g;

/** The size limit of a topic's content. */
export function maxCharsFor(scope: NoteScope, topic: string): number {
  return scope === 'person' && topic === PROFILE_TOPIC ? NOTE_LIMITS.profileMaxChars : NOTE_LIMITS.topicMaxChars;
}

/** The topic limit for a scope. */
export function maxTopicsFor(scope: NoteScope): number {
  return scope === 'person' ? NOTE_LIMITS.maxPersonTopics : NOTE_LIMITS.maxGroupTopics;
}

/** A topic slug, lowercased and trimmed, or undefined when it isn't one. */
export function normalizeTopic(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const topic = raw.trim().toLowerCase();
  if (topic.length === 0 || topic.length > NOTE_LIMITS.topicSlugMaxChars) return undefined;
  return TOPIC_SLUG.test(topic) ? topic : undefined;
}

/** The rule violations in a piece of note text (title or content); empty when it is fine. */
export function noteTextProblems(text: string, allowedIds: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  for (const { pattern, what } of DISCORD_MARKUP) {
    if (pattern.test(text)) problems.push(`contains ${what}`);
  }
  if (HTML_TAG.test(text)) problems.push('contains an HTML tag (markdown only)');
  if (CONTROL_CHARS.test(text)) problems.push('contains control characters');
  const strangers = [...text.matchAll(SNOWFLAKE_LIKE)].map((m) => m[0]).filter((id) => !allowedIds.has(id));
  if (strangers.length > 0) problems.push(`contains a Discord id that wasn't in the input (${strangers[0]})`);
  return problems;
}

/**
 * One note as proposed by a writer: shape, topic slug, a one-line title, markdown content within the
 * topic's size limit, and no Discord markup, HTML or foreign ids. Title and content are trimmed.
 */
export function validateNoteDraft(raw: unknown, ctx: NoteValidationContext): ValidationResult<NoteDraft> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['a note must be an object'] };
  const fields = raw as Record<string, unknown>;
  const topic = normalizeTopic(fields.topic);
  const label = topic ?? (typeof fields.topic === 'string' ? fields.topic.slice(0, 40) : '?');
  const errors: string[] = [];
  const allowed = new Set(ctx.allowedIds ?? []);

  if (!topic) {
    errors.push(
      `note "${label}": the topic must be a lowercase slug (letters, digits, single hyphens; ≤${NOTE_LIMITS.topicSlugMaxChars} chars)`,
    );
  }

  const title = typeof fields.title === 'string' ? fields.title.trim() : undefined;
  if (!title) errors.push(`note "${label}": the title is missing`);
  else {
    if (title.length > NOTE_LIMITS.titleMaxChars) {
      errors.push(`note "${label}": the title is longer than ${NOTE_LIMITS.titleMaxChars} characters`);
    }
    if (/[\r\n]/.test(title)) errors.push(`note "${label}": the title must be one line`);
    for (const problem of noteTextProblems(title, allowed)) errors.push(`note "${label}": the title ${problem}`);
  }

  const content = typeof fields.content === 'string' ? fields.content.replace(/\r\n?/g, '\n').trim() : undefined;
  if (!content) errors.push(`note "${label}": the content is empty`);
  else {
    const max = maxCharsFor(ctx.scope, topic ?? '');
    if (content.length > max) {
      errors.push(`note "${label}": the content is ${content.length} characters, over the ${max} limit`);
    }
    for (const problem of noteTextProblems(content, allowed)) errors.push(`note "${label}": the content ${problem}`);
  }

  if (errors.length > 0 || !topic || !title || !content) return { ok: false, errors };
  return { ok: true, value: { topic, title, content } };
}

/**
 * A writer's whole output for one owner. Every note must pass validateNoteDraft, topics must be unique,
 * removed topics must be slugs that aren't also written, a person's profile can never be removed, and the
 * output can't hold more topics than the scope allows. With `requireProfile` (a dream's or bootstrap's
 * full rewrite of a person) the profile must be among the notes. The change summary is clamped to one
 * line of NOTE_LIMITS.changeSummaryMaxChars.
 */
export function validateNotesOutput(
  raw: unknown,
  ctx: NoteValidationContext & { requireProfile?: boolean },
): ValidationResult<NotesOutput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['the output must be a JSON object with "notes", "removed_topics", "change_summary"'] };
  }
  const fields = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!Array.isArray(fields.notes)) errors.push('"notes" must be an array');
  const notes: NoteDraft[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(fields.notes) ? fields.notes : []) {
    const result = validateNoteDraft(entry, ctx);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    if (seen.has(result.value.topic)) {
      errors.push(`topic "${result.value.topic}" appears twice`);
      continue;
    }
    seen.add(result.value.topic);
    notes.push(result.value);
  }

  const removedRaw = fields.removed_topics ?? [];
  if (!Array.isArray(removedRaw)) errors.push('"removed_topics" must be an array of topic slugs');
  const removed: string[] = [];
  for (const entry of Array.isArray(removedRaw) ? removedRaw : []) {
    const topic = normalizeTopic(entry);
    if (!topic) {
      errors.push(`removed topic "${String(entry).slice(0, 40)}" is not a topic slug`);
      continue;
    }
    if (ctx.scope === 'person' && topic === PROFILE_TOPIC) {
      errors.push('the profile can never be removed');
      continue;
    }
    if (seen.has(topic)) {
      errors.push(`topic "${topic}" is both written and removed`);
      continue;
    }
    if (!removed.includes(topic)) removed.push(topic);
  }

  if (ctx.requireProfile && ctx.scope === 'person' && !seen.has(PROFILE_TOPIC)) {
    errors.push('a person\'s notes must include the "profile" topic');
  }
  const maxTopics = maxTopicsFor(ctx.scope);
  if (notes.length > maxTopics) errors.push(`${notes.length} topics, over the limit of ${maxTopics}`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { notes, removed_topics: removed, change_summary: clampSummary(fields.change_summary) },
  };
}

/** A change summary as one clamped line ('' when missing). */
export function clampSummary(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.replace(/\s+/g, ' ').trim();
  const max = NOTE_LIMITS.changeSummaryMaxChars;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Parses a model's text answer into a NotesOutput: the JSON object itself, or the first `{…}` span in
 * it (models like ```json fences), then validateNotesOutput().
 */
export function parseNotesOutput(
  text: string,
  ctx: NoteValidationContext & { requireProfile?: boolean },
): ValidationResult<NotesOutput> {
  const candidates = [text.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    return validateNotesOutput(parsed, ctx);
  }
  return { ok: false, errors: ['the answer is not a JSON object'] };
}
