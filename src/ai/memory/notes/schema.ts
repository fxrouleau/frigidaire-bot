// Memory v2 notes: the shapes and the validation every writer shares (the notes store, the nightly dream,
// owner edits, the bootstrap import and the built-in bootstrap). Notes are markdown written by a model or
// copied from files, so everything here treats them as untrusted input: a note that breaks a rule is
// refused whole (nothing is clamped into a different meaning), except the free-text change summary, which
// is only ever shown in a log or report line and is clamped. See docs/memory.md.

/**
 * Whose note:
 * - `person`: one member (by main account id): a `profile` plus topic notes.
 * - `group`: the server as a whole (truly server-wide lore, running jokes, vibe).
 * - `circle`: a SET of members sharing something: an interest or sub-group (the MTG crew, the Valorant
 *   squad, roommates) or a pair (two people's history, a rivalry). One note per circle, its topic is the
 *   circle's unique slug, and its membership is dated (CircleMember). A circle that is over can be archived
 *   (status 'archived'): kept as a short historical trace.
 * - `occasion`: one notable thing specific members do together at a date (a trip, an outing somewhere, a
 *   tournament): its topic is a slug unique among occasions, its participants are dated like a circle's
 *   members, and it carries `starts_on`/`ends_on` (partial dates), a `place` and a lifecycle status
 *   (OCCASION_STATUSES). It is planned, happens, becomes history, and is archived some months later.
 */
export type NoteScope = 'person' | 'group' | 'circle' | 'occasion';

/** The scopes whose notes are shared by a set of members (note_members): circles and occasions. */
export type SharedScope = 'circle' | 'occasion';

/**
 * An occasion's status as its last writer gave it. `planned` and `happening` mean the note was written
 * while the occasion was ahead or under way (its Plan); `past` that it was rewritten as history; `cancelled`
 * that the entries said it was off; `archived` that it was compacted to a short trace. Whether an occasion is
 * planned, happening or past right now is derived from its dates and today (lifecycle.ts occasionPhase), as
 * long as it isn't cancelled or archived.
 */
export const OCCASION_STATUSES = ['planned', 'happening', 'past', 'cancelled', 'archived'] as const;
export type OccasionStatus = (typeof OCCASION_STATUSES)[number];
/** The status of an archived circle or occasion (a circle's status is otherwise null). */
export const ARCHIVED_STATUS = 'archived';
/** A note's stored status: an occasion's OccasionStatus, a circle's 'archived' (null while live); null for the rest. */
export type NoteStatus = OccasionStatus;

/** The owner of a set of topic notes. A person is always their MAIN account id (LINKED_ACCOUNTS resolved). */
export type NoteOwner = { scope: 'person'; ownerId: string } | { scope: 'group' };

/** Who wrote a note version. */
export const NOTE_WRITERS = ['dream', 'edit', 'bootstrap', 'import', 'undo'] as const;
export type NoteUpdatedBy = (typeof NOTE_WRITERS)[number];

/** Every person has this topic once they have notes at all: who they are (see PROFILE_SECTIONS). */
export const PROFILE_TOPIC = 'profile';

/**
 * Size limits, checked on every write. The writers' prompts ask for the targets, well under the hard
 * limits: a model can't count characters, and a note written up to its limit fails the next night as soon
 * as one thing is added (the dream on GLM did, every night, for everyone whose bootstrap profile sat at 99%).
 */
export const NOTE_LIMITS = {
  /** A person's profile. */
  profileMaxChars: 4_000,
  /** What a profile aims for: chat turns show a profile's first 3,000 characters without Earlier. */
  profileTargetChars: 3_200,
  /** Any other topic (a person's or the group's). */
  topicMaxChars: 8_000,
  topicTargetChars: 6_500,
  /** A circle's note. */
  circleMaxChars: 6_000,
  circleTargetChars: 5_000,
  /** An occasion's note (its Plan while ahead; what happened and its legacy once past). */
  occasionMaxChars: 4_000,
  occasionTargetChars: 3_000,
  /**
   * The short historical trace an archived circle or occasion is compacted to (the nightly lifecycle pass):
   * what it was, when, who, the highlights and its legacy.
   */
  archivedMaxChars: 1_500,
  archivedTargetChars: 1_200,
  /** Occasions that aren't archived, in all. */
  maxOccasions: 30,
  /** Participants of one occasion (current and those who bailed), and the fewest it can have. */
  maxOccasionParticipants: 30,
  minOccasionParticipants: 2,
  /** Where an occasion takes place ("Tremblant", "the orchard"). */
  placeMaxChars: 80,
  /** Topics per person, the profile included. */
  maxPersonTopics: 10,
  /** Topics for the group. */
  maxGroupTopics: 8,
  /** Live circles in all (present and fading: archived ones don't count). */
  maxCircles: 60,
  /**
   * Present circles one member is currently in (former memberships, fading and archived circles don't count:
   * lifecycle.ts CIRCLE_DECAY). 16, not 12: the core members all sat at 12 and the import had to end real
   * memberships to fit.
   */
  maxCirclesPerMember: 16,
  /** Members of one circle (current and former), and the fewest a circle can have. */
  maxCircleMembers: 30,
  minCircleMembers: 2,
  /** Other names a circle goes by ("the squad"), and their length. */
  maxCircleAliases: 8,
  aliasMaxChars: 40,
  /** A member's role in a circle ("DM", "founder"). */
  roleMaxChars: 40,
  titleMaxChars: 80,
  topicSlugMaxChars: 32,
  /** The change summary a dream or an edit returns (clamped, never refused). */
  changeSummaryMaxChars: 300,
} as const;

/** One person or group note as a writer proposes it. `content` is markdown. */
export type NoteDraft = { topic: string; title: string; content: string };

/**
 * A circle member as a writer proposes it: `id` any account of the member (stored as the main id),
 * `since`/`until` partial dates (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`; `until` null/absent = still a member),
 * an optional short role.
 */
export type CircleMemberDraft = { id: string; since?: string | null; until?: string | null; role?: string | null };

/**
 * One circle as a writer proposes it (also its JSON shape in model output): its slug, title and markdown
 * content, other names it goes by, its FULL membership as it should be (current and former members), and
 * the slugs of duplicate circles folded into it (deactivated by the same write).
 */
export type CircleDraft = {
  slug: string;
  title: string;
  content: string;
  aliases: string[];
  members: CircleMemberDraft[];
  merged_from: string[];
};

/**
 * One occasion as a writer proposes it (also its JSON shape in model output): slug, title and markdown
 * content, other names, `starts_on` (required) and `ends_on` (optional) as partial dates, an optional short
 * `place`, its `status` (null/absent: the stored one is kept, a new occasion gets 'planned', or 'past' when
 * its dates are already behind), and its FULL list of participants (someone who bailed keeps their place
 * with an `until`).
 */
export type OccasionDraft = {
  slug: string;
  title: string;
  content: string;
  aliases: string[];
  starts_on: string;
  ends_on: string | null;
  place: string | null;
  status: OccasionStatus | null;
  participants: CircleMemberDraft[];
  /**
   * The slug of the circle it belongs to (a tradition: each year's outing is an occasion of the circle that
   * holds it), or null. When it happens, it counts as that circle's activity.
   */
  circle: string | null;
};

/** A stored circle membership (also an occasion's participant). */
export type CircleMember = {
  /** The member's main account id. */
  memberId: string;
  since: string | null;
  /** null: still a member. */
  until: string | null;
  role: string | null;
};

/**
 * What a dream, an owner edit and the bootstrap return for ONE owner (a person, the group, or one circle
 * for an edit of a circle), as JSON:
 * - `notes`: the owner's notes to write (new or changed; unchanged ones may be repeated or left out);
 * - `removed_topics`: the owner's topics to remove;
 * - `circles`: circles to create or update (a person's output may only touch circles that person is or
 *   was in; the group's any circle);
 * - `removed_circles`: circle slugs to remove (a mistake, not a circle that drifted apart: that one keeps
 *   its history with dated `until`s);
 * - `archived_circles`: circle slugs to archive (over: everyone moved on). A circle written in `circles`
 *   too is saved with that content and archived; written without being listed here, an archived circle is
 *   revived;
 * - `occasions`: occasions to create or update, each in full (a person's output only touches occasions
 *   that person is or was a participant of);
 * - `removed_occasions`: occasion slugs to remove (a mistake or a duplicate);
 * - `change_summary`: a few words on what changed (the report line and the version history).
 * Everything but `notes`, `removed_topics` and `change_summary` may be absent in the JSON (read as []).
 */
export type NotesOutput = {
  notes: NoteDraft[];
  removed_topics: string[];
  circles: CircleDraft[];
  removed_circles: string[];
  archived_circles: string[];
  occasions: OccasionDraft[];
  removed_occasions: string[];
  change_summary: string;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type NoteValidationContext = {
  /**
   * Whose output this is: a person's, the group's, or one circle's or occasion's (an owner edit of it, or
   * the nightly rewrite of an occasion as history).
   */
  scope: NoteScope;
  /**
   * Discord ids that may appear in note text: the person's own account ids and ids that were in the
   * writer's input. Any other 15–21 digit number is refused (a model copying someone else's id). A
   * circle's own member ids are always allowed in its text.
   */
  allowedIds?: Iterable<string>;
};

/** Lowercase words joined by single hyphens: `profile`, `games`, `running-jokes`, `valorant-squad`. */
export const TOPIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A partial date: `2024`, `2024-08` or `2024-08-15`. */
export const PARTIAL_DATE = /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;
const MEMBER_ID = /^\d{15,21}$/;

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

/** The size limit of a note's content. */
export function maxCharsFor(scope: NoteScope, topic: string): number {
  if (scope === 'circle') return NOTE_LIMITS.circleMaxChars;
  if (scope === 'occasion') return NOTE_LIMITS.occasionMaxChars;
  return scope === 'person' && topic === PROFILE_TOPIC ? NOTE_LIMITS.profileMaxChars : NOTE_LIMITS.topicMaxChars;
}

/** The size a writer aims for in a note's content (see NOTE_LIMITS): well under maxCharsFor(). */
export function targetCharsFor(scope: NoteScope, topic: string): number {
  if (scope === 'circle') return NOTE_LIMITS.circleTargetChars;
  if (scope === 'occasion') return NOTE_LIMITS.occasionTargetChars;
  return scope === 'person' && topic === PROFILE_TOPIC ? NOTE_LIMITS.profileTargetChars : NOTE_LIMITS.topicTargetChars;
}

/** Whether a scope's notes are shared by a set of members (circles and occasions). */
export function isSharedScope(scope: NoteScope): scope is SharedScope {
  return scope === 'circle' || scope === 'occasion';
}

/** The topic limit of an owner. */
export function maxTopicsFor(scope: NoteOwner['scope']): number {
  return scope === 'person' ? NOTE_LIMITS.maxPersonTopics : NOTE_LIMITS.maxGroupTopics;
}

/** A topic (or circle) slug, lowercased and trimmed, or undefined when it isn't one. */
export function normalizeTopic(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const topic = raw.trim().toLowerCase();
  if (topic.length === 0 || topic.length > NOTE_LIMITS.topicSlugMaxChars) return undefined;
  return TOPIC_SLUG.test(topic) ? topic : undefined;
}

/** The rule violations in a piece of note text (title, content, alias, role); empty when it is fine. */
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

/** A one-line title's problems (shared by notes and circles). */
function titleProblems(
  raw: unknown,
  label: string,
  allowed: ReadonlySet<string>,
): { title?: string; errors: string[] } {
  const title = typeof raw === 'string' ? raw.trim() : undefined;
  if (!title) return { errors: [`${label}: the title is missing`] };
  const errors: string[] = [];
  if (title.length > NOTE_LIMITS.titleMaxChars) {
    errors.push(`${label}: the title is longer than ${NOTE_LIMITS.titleMaxChars} characters`);
  }
  if (/[\r\n]/.test(title)) errors.push(`${label}: the title must be one line`);
  for (const problem of noteTextProblems(title, allowed)) errors.push(`${label}: the title ${problem}`);
  return { title, errors };
}

/**
 * Markdown content's problems within a size limit (shared by notes, circles and occasions, and the
 * archived trace the lifecycle pass writes). The content comes back trimmed, line ends normalized.
 */
export function contentProblems(
  raw: unknown,
  label: string,
  max: number,
  allowed: ReadonlySet<string>,
): { content?: string; errors: string[] } {
  const content = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n').trim() : undefined;
  if (!content) return { errors: [`${label}: the content is empty`] };
  const errors: string[] = [];
  if (content.length > max) errors.push(`${label}: the content is ${content.length} characters, over the ${max} limit`);
  for (const problem of noteTextProblems(content, allowed)) errors.push(`${label}: the content ${problem}`);
  return { content, errors };
}

/**
 * One person or group note as proposed by a writer: shape, topic slug, a one-line title, markdown content
 * within the topic's size limit, and no Discord markup, HTML or foreign ids. Title and content are trimmed.
 */
export function validateNoteDraft(raw: unknown, ctx: NoteValidationContext): ValidationResult<NoteDraft> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['a note must be an object'] };
  const fields = raw as Record<string, unknown>;
  const topic = normalizeTopic(fields.topic);
  const label = `note "${topic ?? (typeof fields.topic === 'string' ? fields.topic.slice(0, 40) : '?')}"`;
  const errors: string[] = [];
  const allowed = new Set(ctx.allowedIds ?? []);

  if (!topic) {
    errors.push(
      `${label}: the topic must be a lowercase slug (letters, digits, single hyphens; ≤${NOTE_LIMITS.topicSlugMaxChars} chars)`,
    );
  }
  const title = titleProblems(fields.title, label, allowed);
  const content = contentProblems(fields.content, label, maxCharsFor(ctx.scope, topic ?? ''), allowed);
  errors.push(...title.errors, ...content.errors);

  if (errors.length > 0 || !topic || !title.title || !content.content) return { ok: false, errors };
  return { ok: true, value: { topic, title: title.title, content: content.content } };
}

/** Whether partial date `until` is before `since` (compared at the precision both have). */
export function endsBeforeStart(since: string, until: string): boolean {
  const n = Math.min(since.length, until.length);
  return until.slice(0, n) < since.slice(0, n);
}

/** A partial date (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), null for none, or 'invalid'. */
function partialDate(raw: unknown): string | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isInteger(raw)) return partialDate(String(raw));
  if (typeof raw !== 'string') return 'invalid';
  const value = raw.trim();
  if (value === '') return null;
  return PARTIAL_DATE.test(value) ? value : 'invalid';
}

/** A short one-line plain label (alias, role), or 'invalid'. */
function shortLabel(raw: unknown, max: number, allowed: ReadonlySet<string>): string | 'invalid' {
  if (typeof raw !== 'string') return 'invalid';
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value || value.length > max || /[\r\n]/.test(raw.trim())) return 'invalid';
  return noteTextProblems(value, allowed).length > 0 ? 'invalid' : value;
}

/**
 * One circle as proposed by a writer: slug, one-line title, markdown content within the circle limit,
 * aliases (≤ NOTE_LIMITS.maxCircleAliases short one-line names), and its membership: 2–30 distinct
 * snowflake-shaped ids, each with optional partial-date `since`/`until` (until not before since) and a
 * short role; `merged_from` slugs other than its own. The members' own ids may appear in the text. Member
 * ids are checked for shape only here: the store resolves linked accounts and refuses ids nobody knows.
 */
export function validateCircleDraft(
  raw: unknown,
  ctx: Pick<NoteValidationContext, 'allowedIds'> = {},
): ValidationResult<CircleDraft> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, errors: ['a circle must be an object'] };
  const fields = raw as Record<string, unknown>;
  const slug = normalizeTopic(fields.slug);
  const label = `circle "${slug ?? (typeof fields.slug === 'string' ? fields.slug.slice(0, 40) : '?')}"`;
  const errors: string[] = [];
  if (!slug) {
    errors.push(
      `${label}: the slug must be a lowercase slug (letters, digits, single hyphens; ≤${NOTE_LIMITS.topicSlugMaxChars} chars)`,
    );
  }

  const members = memberList(fields.members, label, errors, {
    field: 'members',
    what: 'member',
    min: NOTE_LIMITS.minCircleMembers,
    max: NOTE_LIMITS.maxCircleMembers,
    kind: 'a circle',
  });

  const allowed = new Set([...(ctx.allowedIds ?? []), ...members.map((m) => m.id)]);
  const title = titleProblems(fields.title, label, allowed);
  const content = contentProblems(fields.content, label, NOTE_LIMITS.circleMaxChars, allowed);
  errors.push(...title.errors, ...content.errors);
  const aliases = aliasList(fields.aliases, label, allowed, errors);

  const mergedFrom: string[] = [];
  const rawMerged = fields.merged_from ?? [];
  if (!Array.isArray(rawMerged)) errors.push(`${label}: "merged_from" must be an array of circle slugs`);
  for (const entry of Array.isArray(rawMerged) ? rawMerged : []) {
    const merged = normalizeTopic(entry);
    if (!merged) errors.push(`${label}: merged_from "${String(entry).slice(0, 40)}" is not a slug`);
    else if (merged === slug) errors.push(`${label}: a circle can't be merged into itself`);
    else if (!mergedFrom.includes(merged)) mergedFrom.push(merged);
  }

  if (errors.length > 0 || !slug || !title.title || !content.content) return { ok: false, errors };
  return {
    ok: true,
    value: { slug, title: title.title, content: content.content, aliases, members, merged_from: mergedFrom },
  };
}

/**
 * A circle's members or an occasion's participants: distinct snowflake-shaped ids, each with optional
 * partial-date `since`/`until` (until not before since) and a short role, between `min` and `max` of them.
 * Problems go to `errors`; the valid entries come back.
 */
function memberList(
  raw: unknown,
  label: string,
  errors: string[],
  opts: { field: string; what: string; min: number; max: number; kind: string },
): CircleMemberDraft[] {
  const members: CircleMemberDraft[] = [];
  if (!Array.isArray(raw)) errors.push(`${label}: "${opts.field}" must be an array`);
  for (const entry of Array.isArray(raw) ? raw : []) {
    const member =
      entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const id =
      typeof member.id === 'number' ? String(member.id) : typeof member.id === 'string' ? member.id.trim() : '';
    if (!MEMBER_ID.test(id)) {
      errors.push(`${label}: a ${opts.what} id must be a Discord id (got "${String(member.id ?? '').slice(0, 30)}")`);
      continue;
    }
    if (members.some((m) => m.id === id)) {
      errors.push(`${label}: ${opts.what} ${id} is listed twice`);
      continue;
    }
    const since = partialDate(member.since);
    const until = partialDate(member.until);
    if (since === 'invalid' || until === 'invalid') {
      errors.push(`${label}: ${opts.what} ${id}'s since/until must be YYYY, YYYY-MM or YYYY-MM-DD`);
      continue;
    }
    if (since && until && endsBeforeStart(since, until)) {
      errors.push(`${label}: ${opts.what} ${id} leaves (${until}) before joining (${since})`);
      continue;
    }
    let role: string | null = null;
    if (member.role !== undefined && member.role !== null && member.role !== '') {
      const parsed = shortLabel(member.role, NOTE_LIMITS.roleMaxChars, new Set());
      if (parsed === 'invalid') {
        errors.push(
          `${label}: ${opts.what} ${id}'s role must be plain text up to ${NOTE_LIMITS.roleMaxChars} characters`,
        );
        continue;
      }
      role = parsed;
    }
    members.push({ id, since, until, role });
  }
  if (Array.isArray(raw)) {
    if (members.length < opts.min && errors.length === 0) {
      errors.push(`${label}: ${opts.kind} has at least ${opts.min} ${opts.what}s`);
    }
    if (members.length > opts.max) {
      errors.push(`${label}: ${members.length} ${opts.what}s, over the limit of ${opts.max}`);
    }
  }
  return members;
}

/** Other names a circle or occasion goes by (≤ NOTE_LIMITS.maxCircleAliases short one-line names, deduped). */
function aliasList(raw: unknown, label: string, allowed: ReadonlySet<string>, errors: string[]): string[] {
  const aliases: string[] = [];
  const list = raw ?? [];
  if (!Array.isArray(list)) errors.push(`${label}: "aliases" must be an array of names`);
  for (const entry of Array.isArray(list) ? list : []) {
    const alias = shortLabel(entry, NOTE_LIMITS.aliasMaxChars, allowed);
    if (alias === 'invalid') {
      errors.push(`${label}: an alias must be plain one-line text up to ${NOTE_LIMITS.aliasMaxChars} characters`);
      continue;
    }
    if (!aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
  }
  if (aliases.length > NOTE_LIMITS.maxCircleAliases) {
    errors.push(`${label}: ${aliases.length} aliases, over the limit of ${NOTE_LIMITS.maxCircleAliases}`);
  }
  return aliases;
}

/** An occasion status from a writer: one of OCCASION_STATUSES (any case), null for none, or 'invalid'. */
function occasionStatus(raw: unknown): OccasionStatus | null | 'invalid' {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return 'invalid';
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  return (OCCASION_STATUSES as readonly string[]).includes(value) ? (value as OccasionStatus) : 'invalid';
}

/**
 * One occasion as proposed by a writer: slug, one-line title, markdown content within the occasion limit,
 * aliases, `starts_on` (a partial date, required) and `ends_on` (optional, not before it), an optional short
 * one-line `place`, an optional status (OCCASION_STATUSES), and its participants: 2–30 like a circle's
 * members ("members" is read when "participants" is missing: models mix them up). The participants' own ids
 * may appear in the text. Ids are checked for shape only: the store resolves linked accounts and refuses ids
 * nobody knows.
 */
export function validateOccasionDraft(
  raw: unknown,
  ctx: Pick<NoteValidationContext, 'allowedIds'> = {},
): ValidationResult<OccasionDraft> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['an occasion must be an object'] };
  }
  const fields = raw as Record<string, unknown>;
  const slug = normalizeTopic(fields.slug);
  const label = `occasion "${slug ?? (typeof fields.slug === 'string' ? fields.slug.slice(0, 40) : '?')}"`;
  const errors: string[] = [];
  if (!slug) {
    errors.push(
      `${label}: the slug must be a lowercase slug (letters, digits, single hyphens; ≤${NOTE_LIMITS.topicSlugMaxChars} chars)`,
    );
  }

  const startsOn = partialDate(fields.starts_on);
  const endsOn = partialDate(fields.ends_on);
  if (startsOn === null) errors.push(`${label}: "starts_on" is required (YYYY, YYYY-MM or YYYY-MM-DD)`);
  if (startsOn === 'invalid') errors.push(`${label}: "starts_on" must be YYYY, YYYY-MM or YYYY-MM-DD`);
  if (endsOn === 'invalid') errors.push(`${label}: "ends_on" must be YYYY, YYYY-MM or YYYY-MM-DD, or null`);
  if (startsOn && startsOn !== 'invalid' && endsOn && endsOn !== 'invalid' && endsBeforeStart(startsOn, endsOn)) {
    errors.push(`${label}: it ends (${endsOn}) before it starts (${startsOn})`);
  }
  const status = occasionStatus(fields.status);
  if (status === 'invalid') errors.push(`${label}: "status" must be one of ${OCCASION_STATUSES.join(', ')}`);

  const participants = memberList(fields.participants ?? fields.members, label, errors, {
    field: 'participants',
    what: 'participant',
    min: NOTE_LIMITS.minOccasionParticipants,
    max: NOTE_LIMITS.maxOccasionParticipants,
    kind: 'an occasion',
  });

  const allowed = new Set([...(ctx.allowedIds ?? []), ...participants.map((m) => m.id)]);
  let place: string | null = null;
  if (fields.place !== undefined && fields.place !== null && fields.place !== '') {
    const parsed = shortLabel(fields.place, NOTE_LIMITS.placeMaxChars, allowed);
    if (parsed === 'invalid') {
      errors.push(`${label}: "place" must be plain one-line text up to ${NOTE_LIMITS.placeMaxChars} characters`);
    } else place = parsed;
  }
  const title = titleProblems(fields.title, label, allowed);
  const content = contentProblems(fields.content, label, NOTE_LIMITS.occasionMaxChars, allowed);
  errors.push(...title.errors, ...content.errors);
  const aliases = aliasList(fields.aliases, label, allowed, errors);
  let circle: string | null = null;
  if (fields.circle !== undefined && fields.circle !== null && fields.circle !== '') {
    const parsed = normalizeTopic(fields.circle);
    if (!parsed) errors.push(`${label}: "circle" must be a circle's slug, or null`);
    else circle = parsed;
  }

  if (errors.length > 0 || !slug || !title.title || !content.content || !startsOn || startsOn === 'invalid') {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      slug,
      title: title.title,
      content: content.content,
      aliases,
      starts_on: startsOn,
      ends_on: endsOn === 'invalid' ? null : endsOn,
      place,
      status: status === 'invalid' ? null : status,
      participants,
      circle,
    },
  };
}

/**
 * A writer's whole output for one owner (see NotesOutput). Every note must pass validateNoteDraft and every
 * circle validateCircleDraft; topics and circle slugs must be unique, removed topics/circles must be slugs
 * that aren't also written, a person's profile can never be removed, and the output can't hold more
 * topics than the scope allows. Occasions must pass validateOccasionDraft, with unique slugs. An output
 * for one circle (`ctx.scope === 'circle'`) writes exactly that circle (and may archive it); one for an
 * occasion writes exactly that occasion and nothing else. With `requireProfile` (a dream's or bootstrap's
 * full rewrite of a person) the profile must be among the notes. The change summary is clamped to one line
 * of NOTE_LIMITS.changeSummaryMaxChars. Cross-owner rules (a person's output only touches that person's
 * circles and occasions; circle, occasion and member counts) are the store's (NotesStore.applyNotesOutput),
 * which knows the current state.
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
  const single = isSharedScope(ctx.scope);

  if (!Array.isArray(fields.notes) && !(single && fields.notes === undefined)) {
    errors.push('"notes" must be an array');
  }
  const notes: NoteDraft[] = [];
  const seen = new Set<string>();
  const rawNotes = Array.isArray(fields.notes) ? fields.notes : [];
  if (ctx.scope === 'circle' && rawNotes.length > 0) errors.push('an edit of a circle writes only "circles"');
  if (ctx.scope === 'occasion' && rawNotes.length > 0) errors.push('an occasion is written in "occasions" only');
  // Whether the answer holds a profile at all, valid or not: one refused for its size is still there.
  const hasProfile = rawNotes.some(
    (entry) =>
      entry && typeof entry === 'object' && normalizeTopic((entry as Record<string, unknown>).topic) === PROFILE_TOPIC,
  );
  for (const entry of single ? [] : rawNotes) {
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

  const removed = slugList(fields.removed_topics, '"removed_topics"', 'removed topic', errors);
  if (single && removed.length > 0) errors.push(`an edit of ${article(ctx.scope)} removes no topics`);
  for (const topic of removed) {
    if (ctx.scope === 'person' && topic === PROFILE_TOPIC) errors.push('the profile can never be removed');
    else if (seen.has(topic)) errors.push(`topic "${topic}" is both written and removed`);
  }

  const circles: CircleDraft[] = [];
  const circleSlugs = new Set<string>();
  const rawCircles = fields.circles ?? [];
  if (!Array.isArray(rawCircles)) errors.push('"circles" must be an array');
  for (const entry of Array.isArray(rawCircles) ? rawCircles : []) {
    const result = validateCircleDraft(entry, ctx);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    if (circleSlugs.has(result.value.slug)) {
      errors.push(`circle "${result.value.slug}" appears twice`);
      continue;
    }
    circleSlugs.add(result.value.slug);
    circles.push(result.value);
  }
  const removedCircles = slugList(fields.removed_circles, '"removed_circles"', 'removed circle', errors);
  for (const slug of removedCircles) {
    if (circleSlugs.has(slug)) errors.push(`circle "${slug}" is both written and removed`);
  }
  const mergedAway = new Set(circles.flatMap((c) => c.merged_from));
  for (const circle of circles) {
    for (const merged of circle.merged_from) {
      if (circleSlugs.has(merged)) errors.push(`circle "${merged}" is both written and merged into "${circle.slug}"`);
    }
  }
  const archivedCircles = slugList(fields.archived_circles, '"archived_circles"', 'archived circle', errors);
  for (const slug of archivedCircles) {
    if (removedCircles.includes(slug)) errors.push(`circle "${slug}" is both removed and archived`);
    else if (mergedAway.has(slug)) errors.push(`circle "${slug}" is both merged away and archived`);
  }
  if (ctx.scope === 'circle') {
    // Exactly that circle: written (and maybe archived with its new text), or only archived as it is.
    const archivesOnly = circles.length === 0 && archivedCircles.length === 1 && removedCircles.length === 0;
    if (circles.length !== 1 && !archivesOnly) errors.push('an edit of a circle writes exactly that circle');
    if (circles.length === 1 && archivedCircles.some((slug) => !circleSlugs.has(slug))) {
      errors.push('an edit of a circle archives no other circle');
    }
  }

  const occasions: OccasionDraft[] = [];
  const occasionSlugs = new Set<string>();
  const rawOccasions = fields.occasions ?? [];
  if (!Array.isArray(rawOccasions)) errors.push('"occasions" must be an array');
  for (const entry of Array.isArray(rawOccasions) ? rawOccasions : []) {
    const result = validateOccasionDraft(entry, ctx);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }
    if (occasionSlugs.has(result.value.slug)) {
      errors.push(`occasion "${result.value.slug}" appears twice`);
      continue;
    }
    occasionSlugs.add(result.value.slug);
    occasions.push(result.value);
  }
  const removedOccasions = slugList(fields.removed_occasions, '"removed_occasions"', 'removed occasion', errors);
  for (const slug of removedOccasions) {
    if (occasionSlugs.has(slug)) errors.push(`occasion "${slug}" is both written and removed`);
  }
  if (ctx.scope === 'circle' && (occasions.length > 0 || removedOccasions.length > 0)) {
    errors.push('an edit of a circle writes no occasions');
  }
  if (ctx.scope === 'occasion') {
    if (occasions.length !== 1) errors.push('an occasion is written exactly: one entry in "occasions"');
    if (circles.length > 0 || removedCircles.length > 0 || archivedCircles.length > 0 || removedOccasions.length > 0) {
      errors.push('an occasion is written alone: no circles, no removals');
    }
  }

  if (ctx.requireProfile && ctx.scope === 'person' && !hasProfile) {
    errors.push('a person\'s notes must include the "profile" topic');
  }
  if (ctx.scope === 'person' || ctx.scope === 'group') {
    const maxTopics = maxTopicsFor(ctx.scope);
    if (notes.length > maxTopics) errors.push(`${notes.length} topics, over the limit of ${maxTopics}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      notes,
      removed_topics: removed,
      circles,
      removed_circles: removedCircles,
      archived_circles: archivedCircles,
      occasions,
      removed_occasions: removedOccasions,
      change_summary: clampSummary(fields.change_summary),
    },
  };
}

function article(scope: NoteScope): string {
  return scope === 'occasion' ? 'an occasion' : `a ${scope}`;
}

/** An optional array of slugs (deduped); problems go to `errors`. */
function slugList(raw: unknown, field: string, what: string, errors: string[]): string[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) {
    errors.push(`${field} must be an array of slugs`);
    return [];
  }
  const slugs: string[] = [];
  for (const entry of list) {
    const slug = normalizeTopic(entry);
    if (!slug) errors.push(`${what} "${String(entry).slice(0, 40)}" is not a slug`);
    else if (!slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/** A change summary as one clamped line ('' when missing). */
export function clampSummary(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const line = raw.replace(/\s+/g, ' ').trim();
  const max = NOTE_LIMITS.changeSummaryMaxChars;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * The JSON in a model's text answer: the whole text, or the first `{…}` span in it (models like ```json
 * fences). Undefined when neither parses.
 */
export function extractJson(text: string): { value: unknown } | undefined {
  const candidates = [text.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {}
  }
  return undefined;
}

/** Parses a model's text answer into a NotesOutput: extractJson(), then validateNotesOutput(). */
export function parseNotesOutput(
  text: string,
  ctx: NoteValidationContext & { requireProfile?: boolean },
): ValidationResult<NotesOutput> {
  const json = extractJson(text);
  return json ? validateNotesOutput(json.value, ctx) : { ok: false, errors: ['the answer is not a JSON object'] };
}
