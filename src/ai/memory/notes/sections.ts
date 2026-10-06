// The shape of a note (docs/memory.md "Recency and recurrence"): old things people mostly forgot are
// footnotes, not identity. A profile reads
//
//   ## Now                 who they are these days (~200–400 words)
//   ## Traits              how they talk and joke, long-running habits
//   ## Circles & people    their circles (title + one line) and closest relationships
//   ## Earlier             dated footnotes: superseded facts, things seen once long ago ("back in 2017 …")
//
// and topic notes and circles split Now / Earlier the same way. Chat turns see a note without its Earlier
// part (withoutEarlier); Earlier comes up on demand (read_note) or through search. The dream writes this
// shape; nothing refuses a note without it (owner edits and imports stay free-form), noteShapeWarnings()
// only reports what is off. Pure string functions.

/** A profile's sections, in order. */
export const PROFILE_SECTIONS = ['Now', 'Traits', 'Circles & people', 'Earlier'] as const;
/** A topic note's or circle's sections, in order. */
export const TOPIC_SECTIONS = ['Now', 'Earlier'] as const;
/**
 * An occasion's sections: while it is ahead or under way its Plan (when, where, who, bookings, open
 * questions: logistics belong here, unlike in profiles) and what happened so far; once past, what happened
 * and the legacy it left (running jokes, core memories).
 */
export const OCCASION_PLAN_SECTIONS = ['Plan', 'So far'] as const;
export const OCCASION_HISTORY_SECTIONS = ['What happened', 'Legacy'] as const;
/** The heading of the dated-footnotes section chat turns leave out. */
export const EARLIER_HEADING = 'Earlier';

export type NoteSection = {
  /** The heading's text ('' for the part before the first heading). */
  heading: string;
  /** 1–6 for `#`…`######`; 0 for the part before the first heading. */
  level: number;
  /** The section's text, its heading line included (as written). */
  text: string;
};

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** A markdown note cut at its headings (fenced code is never read as a heading). */
export function splitSections(markdown: string): NoteSection[] {
  const sections: NoteSection[] = [];
  let current: NoteSection = { heading: '', level: 0, text: '' };
  const lines: string[] = [];
  let inFence = false;
  const flush = () => {
    current.text = lines.join('\n');
    if (current.level > 0 || current.text.trim()) sections.push(current);
    lines.length = 0;
  };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      flush();
      current = { heading: heading[2].trim(), level: heading[1].length, text: '' };
    }
    lines.push(line);
  }
  flush();
  return sections;
}

function isEarlier(heading: string): boolean {
  return heading.trim().toLowerCase().startsWith(EARLIER_HEADING.toLowerCase());
}

/**
 * The note without its Earlier section(s) (an "Earlier…" heading and everything under it, up to the next
 * heading of the same or a higher level). A note without one is returned as is (trimmed).
 */
export function withoutEarlier(markdown: string): string {
  const kept: string[] = [];
  let skipLevel = 0;
  for (const section of splitSections(markdown)) {
    if (skipLevel > 0 && section.level > skipLevel) continue;
    skipLevel = 0;
    if (section.level > 0 && isEarlier(section.heading)) {
      skipLevel = section.level;
      continue;
    }
    kept.push(section.text);
  }
  return kept.join('\n').trim();
}

/** Only the Earlier section(s) of a note (headings included), or '' when it has none. */
export function earlierPart(markdown: string): string {
  const kept: string[] = [];
  let keepLevel = 0;
  for (const section of splitSections(markdown)) {
    if (keepLevel > 0 && section.level > keepLevel) {
      kept.push(section.text);
      continue;
    }
    keepLevel = 0;
    if (section.level > 0 && isEarlier(section.heading)) {
      keepLevel = section.level;
      kept.push(section.text);
    }
  }
  return kept.join('\n').trim();
}

/** A level-2 heading's key: its first word, lowercased ("Circles and people" and "Circles & people" → "circles"). */
function headingKey(heading: string): string {
  return (
    heading
      .trim()
      .toLowerCase()
      .split(/[^a-z0-9]+/)[0] ?? ''
  );
}

/** The keys of a note's level-2 headings (see headingKey). */
export function headingKeys(content: string): Set<string> {
  return new Set(
    splitSections(content)
      .filter((s) => s.level === 2)
      .map((s) => headingKey(s.heading)),
  );
}

/** The share of a profile's text (Earlier left out) a rewrite must keep, for a profile at least PROFILE_DAMAGE_FLOOR long. */
export const PROFILE_MIN_KEPT_SHARE = 0.5;
export const PROFILE_DAMAGE_FLOOR = 1_200;
const CORE_PROFILE_SECTIONS = ['now', 'traits', 'circles'];

/**
 * How a rewrite of a profile damaged it, compared with `before`: the core sections (Now, Traits, Circles &
 * people; Earlier may be trimmed away) it had and lost, and whether less than PROFILE_MIN_KEPT_SHARE of its
 * text outside Earlier is left. Damaged = Now lost, two core sections lost, or that much text gone: one
 * section can legitimately go (someone who left their only circle).
 */
export function profileDamage(before: string, after: string): { lost: string[]; shrunk: boolean; damaged: boolean } {
  const had = headingKeys(before);
  const has = headingKeys(after);
  const lost = CORE_PROFILE_SECTIONS.filter((key) => had.has(key) && !has.has(key));
  const length = withoutEarlier(before).length;
  const shrunk = length >= PROFILE_DAMAGE_FLOOR && withoutEarlier(after).length < length * PROFILE_MIN_KEPT_SHARE;
  return { lost, shrunk, damaged: lost.includes('now') || lost.length >= 2 || shrunk };
}

/**
 * What is off about a note's shape (a profile against PROFILE_SECTIONS, anything else against
 * TOPIC_SECTIONS): missing `## Now`, sections out of order. Advisory: writers may retry or log, the
 * store never refuses a note for its shape.
 */
export function noteShapeWarnings(content: string, kind: 'profile' | 'topic'): string[] {
  const expected: readonly string[] = kind === 'profile' ? PROFILE_SECTIONS : TOPIC_SECTIONS;
  const headings = splitSections(content)
    .filter((s) => s.level === 2)
    .map((s) => s.heading.toLowerCase());
  const warnings: string[] = [];
  if (!headings.includes('now')) warnings.push('no "## Now" section');
  if (kind === 'profile') {
    for (const name of ['Traits', 'Circles & people']) {
      if (!headings.includes(name.toLowerCase())) warnings.push(`no "## ${name}" section`);
    }
  }
  const order = headings.map((h) => expected.findIndex((e) => h.startsWith(e.toLowerCase()))).filter((i) => i >= 0);
  if (order.some((index, i) => i > 0 && index < order[i - 1])) {
    warnings.push(`sections out of order (expected ${expected.join(', ')})`);
  }
  return warnings;
}

/**
 * What is off about an occasion's shape for where it is: a planned or happening one without `## Plan`, a
 * past one without `## What happened` (or still carrying its Plan). An archived trace has no fixed shape.
 * Advisory, like noteShapeWarnings().
 */
export function occasionShapeWarnings(content: string, phase: 'plan' | 'history' | 'trace'): string[] {
  if (phase === 'trace') return [];
  const headings = splitSections(content)
    .filter((s) => s.level === 2)
    .map((s) => s.heading.toLowerCase());
  const has = (name: string) => headings.some((h) => h.startsWith(name.toLowerCase()));
  if (phase === 'plan') return has('Plan') ? [] : ['no "## Plan" section'];
  const warnings: string[] = [];
  if (!has('What happened')) warnings.push('no "## What happened" section');
  if (has('Plan')) warnings.push('still has its "## Plan" section');
  return warnings;
}

/**
 * The note with its `## Plan` section (and anything nested under it) moved right after the text before the
 * first heading: what a chat turn about an upcoming occasion needs first. A note without one is returned as
 * is (trimmed).
 */
export function planFirst(markdown: string): string {
  const sections = splitSections(markdown);
  const at = sections.findIndex((s) => s.level === 2 && s.heading.toLowerCase().startsWith('plan'));
  if (at < 0) return markdown.trim();
  let end = at + 1;
  while (end < sections.length && sections[end].level > 2) end++;
  const plan = sections.slice(at, end);
  const rest = [...sections.slice(0, at), ...sections.slice(end)];
  const intro = rest[0]?.level === 0 ? [rest.shift() as NoteSection] : [];
  return [...intro, ...plan, ...rest]
    .map((s) => s.text.trim())
    .filter((t) => t)
    .join('\n\n');
}
