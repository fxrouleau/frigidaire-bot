// What the capture extractor already knows (memory v2, docs/memory.md "Capture"): so it saves only what is
// new, it gets, for the people in the conversation (the authors, plus the members the conversation talks
// about) and for the server, their notes in short (the profile without its Earlier footnotes, their
// circles) and the journal rows newer than the notes, including open corrections. A person without notes
// yet gets their saved memories instead, as before memory v2. Reads only; a failure for one person is
// logged and leaves that person out, never the capture.
import { canonicalUserId } from '../../linkedAccounts';
import { logger } from '../../logger';
import type { Memory, MemoryStore } from '../memory/memoryStore';
import { chatExcerpt, circlesLine, correctionLine, describeParticipants } from '../memory/notes/context';
import {
  byOccasionRelevance,
  daysBetween,
  describePhase,
  easternDayOfTimestamp,
  OCCASION_LIFECYCLE,
  occasionDates,
  occasionEndDay,
  occasionPhase,
} from '../memory/notes/lifecycle';
import type { Note, NotesStore } from '../memory/notes/notesStore';
import { PROFILE_TOPIC } from '../memory/notes/schema';
import { planFirst } from '../memory/notes/sections';
import { memoryKeyFor } from '../people';
import { formatRelativeAge } from '../utils';

export const KNOWN_LIMITS = {
  /** A person's profile, Earlier left out: enough to recognize what is known. */
  profileMaxChars: 1_000,
  /** Journal rows newer than a person's notes (the newest). */
  journalRows: 12,
  /** Open corrections about a person (the newest). */
  corrections: 5,
  /** Saved memories of a person without notes (the most recently updated), as before memory v2. */
  fallbackRows: 25,
  /** The server's notes together. */
  groupNotesMaxChars: 1_500,
  /** Server rows (newer than the group notes, or the most recently updated without notes). */
  groupRows: 25,
  /** Members the conversation talks about, besides its authors (the most referenced). */
  referencedPeople: 5,
  /** Open occasions of these people (planned, happening, or past/cancelled in the last two weeks). */
  occasions: 8,
  /** How much of each occasion's note (its Plan first) is shown. */
  occasionExcerptChars: 300,
} as const;

/** Someone in the conversation: their main account id when known (an unmatched old relay has only a name). */
export type CapturePerson = { userId?: string; name: string };

/** How one journal row reads in the section. */
export type KnownRowFormat = (row: Memory) => string;

const defaultRowLine: KnownRowFormat = (m) => `- [${m.category}] ${m.subject}: ${m.content}`;

/**
 * The "already known" section of the capture prompt: one block per person (in the given order, each person
 * once) and one for the server, rows deduped across blocks. '(none yet)' when nothing is known.
 * `rowLine` renders each journal row (the built-in bootstrap adds its seen span and count); with
 * `maxChars`, a person's block that would pass it is left out (the server's block still gets its turn).
 */
export function buildCaptureKnowledge(args: {
  store: MemoryStore;
  notes: NotesStore;
  people: readonly CapturePerson[];
  now: Date;
  rowLine?: KnownRowFormat;
  maxChars?: number;
}): string {
  const { store, notes, now } = args;
  const rowLine = args.rowLine ?? defaultRowLine;
  const budget = args.maxChars ?? Number.POSITIVE_INFINITY;
  const shown = new Set<number>();
  // Rows count as shown only once their block is kept (a block over budget gives its rows back).
  const pending: number[] = [];
  const fresh = (rows: Memory[]) =>
    rows.filter((m) => !shown.has(m.id) && !pending.includes(m.id) && pending.push(m.id) > 0);
  const nameOf = (userId: string) => store.getIdentityById(canonicalUserId(userId))?.display_name;
  const blocks: string[] = [];
  let used = 0;
  const keep = (block: string, force = false): void => {
    const cost = block.length + 2;
    if (block && (force || used + cost <= budget)) {
      blocks.push(block);
      used += cost;
      for (const id of pending) shown.add(id);
    }
    pending.length = 0;
  };
  const done = new Set<string>();

  for (const person of args.people) {
    const key = person.userId ? `id:${canonicalUserId(person.userId)}` : `name:${person.name}`;
    if (done.has(key)) continue;
    done.add(key);
    try {
      keep(
        person.userId
          ? personBlock(store, notes, person.userId, person.name, fresh, nameOf, now, rowLine)
          : nameOnlyBlock(store, person.name, fresh, rowLine),
      );
    } catch (error) {
      pending.length = 0;
      logger.warn(`capture: couldn't read what is known about ${person.name}:`, error);
    }
  }

  // The server block is forced in when no person's block made it: the occasions never take that slot.
  const noPeopleShown = blocks.length === 0;
  try {
    const ids = args.people.flatMap((p) => (p.userId ? [canonicalUserId(p.userId)] : []));
    keep(occasionsBlock(notes, ids, nameOf, now));
  } catch (error) {
    pending.length = 0;
    logger.warn("capture: couldn't read the occasions of the people in it:", error);
  }

  try {
    keep(serverBlock(store, notes, fresh, rowLine), noPeopleShown);
  } catch (error) {
    pending.length = 0;
    logger.warn("capture: couldn't read what is known about the server:", error);
  }

  return blocks.length > 0 ? blocks.join('\n\n') : '(none yet)';
}

/** Whether capture should know an occasion: planned or happening, or past or cancelled within two weeks. */
function isOpen(occasion: Note, today: string): boolean {
  const phase = occasionPhase(occasion, today);
  if (phase === 'planned' || phase === 'happening') return true;
  if (phase === 'archived') return false;
  const since = phase === 'cancelled' ? easternDayOfTimestamp(occasion.updatedAt) : occasionEndDay(occasion);
  return since !== undefined && daysBetween(since, today) <= OCCASION_LIFECYCLE.recentlyPastDays;
}

/**
 * The open occasions of these people (current or former participants), the most relevant first: so a
 * conversation about a known trip becomes an update of it ("Ski trip: moved to March") instead of a
 * second plan, and a cancellation names what was called off. '' when none.
 */
function occasionsBlock(
  notes: NotesStore,
  people: string[],
  nameOf: (userId: string) => string | undefined,
  now: Date,
): string {
  if (people.length === 0) return '';
  const today = notes.today();
  const byId = new Map<number, Note>();
  for (const id of people) {
    for (const { occasion } of notes.occasionsOf(id, { includeFormer: true })) byId.set(occasion.id, occasion);
  }
  const open = [...byId.values()]
    .filter((o) => isOpen(o, today))
    .sort(byOccasionRelevance(today))
    .slice(0, KNOWN_LIMITS.occasions);
  if (open.length === 0) return '';
  const lines = open.map((o) => {
    const where = o.place ? `, ${o.place}` : '';
    const who = describeParticipants(o.members, nameOf) || 'nobody listed';
    const age = formatRelativeAge(o.updatedAt, now);
    const text = planFirst(o.content).replace(/\s+/g, ' ').trim();
    const excerpt =
      text.length > KNOWN_LIMITS.occasionExcerptChars
        ? `${text.slice(0, KNOWN_LIMITS.occasionExcerptChars - 1).trimEnd()}…`
        : text;
    return `- "${o.title}" (${occasionDates(o)}${where}; ${describePhase(o, today)}; with ${who}${age ? `; notes updated ${age}` : ''}): ${excerpt}`;
  });
  return `Occasions these people are part of (an update, a change of plan or a cancellation is an "event" row that starts with the occasion's title):\n${lines.join('\n')}`;
}

function personBlock(
  store: MemoryStore,
  notes: NotesStore,
  userId: string,
  name: string,
  fresh: (rows: Memory[]) => Memory[],
  nameOf: (userId: string) => string | undefined,
  now: Date,
  rowLine: KnownRowFormat,
): string {
  const key = memoryKeyFor(store, userId, [name]);
  const heading = `${name} (id:${key.userId}):`;
  const profile = notes.getNote({ scope: 'person', ownerId: key.userId }, PROFILE_TOPIC);
  if (!profile) {
    const rows = fresh(store.getForPerson(key, KNOWN_LIMITS.fallbackRows));
    return rows.length > 0 ? `${heading}\n${rows.map(rowLine).join('\n')}` : '';
  }

  const owner = { scope: 'person' as const, ownerId: key.userId, names: key.names };
  const age = formatRelativeAge(profile.updatedAt, now);
  const parts = [
    `Your notes${age ? ` (updated ${age})` : ''}:\n${chatExcerpt(profile.content, KNOWN_LIMITS.profileMaxChars)}`,
  ];
  const circles = circlesLine(notes.circlesOf(key.userId));
  if (circles) parts.push(circles);
  const journal = fresh(notes.newJournal(owner, { kinds: 'observations', limit: KNOWN_LIMITS.journalRows }));
  if (journal.length > 0) parts.push(`Newer than the notes:\n${journal.map(rowLine).join('\n')}`);
  const corrections = fresh(notes.openCorrections(owner, KNOWN_LIMITS.corrections));
  if (corrections.length > 0) {
    parts.push(
      `Corrections not in the notes yet:\n${corrections.map((row) => correctionLine(row, nameOf, now)).join('\n')}`,
    );
  }
  return `${heading}\n${parts.join('\n')}`;
}

function nameOnlyBlock(
  store: MemoryStore,
  name: string,
  fresh: (rows: Memory[]) => Memory[],
  rowLine: KnownRowFormat,
): string {
  const rows = fresh(store.getForPerson({ names: [name] }, KNOWN_LIMITS.fallbackRows));
  return rows.length > 0 ? `${name}:\n${rows.map(rowLine).join('\n')}` : '';
}

function serverBlock(
  store: MemoryStore,
  notes: NotesStore,
  fresh: (rows: Memory[]) => Memory[],
  rowLine: KnownRowFormat,
): string {
  const groupNotes = notes.listNotes({ scope: 'group' });
  const parts: string[] = [];
  let rows: Memory[];
  if (groupNotes.length > 0) {
    const share = Math.floor(KNOWN_LIMITS.groupNotesMaxChars / groupNotes.length);
    parts.push(...groupNotes.map((note) => `### ${note.title}\n${chatExcerpt(note.content, share)}`));
    rows = fresh(notes.newJournal({ scope: 'group' }, { kinds: 'observations', limit: KNOWN_LIMITS.groupRows }));
    if (rows.length > 0) parts.push(`Newer than the notes:\n${rows.map(rowLine).join('\n')}`);
  } else {
    rows = fresh(store.getBySubject('server', KNOWN_LIMITS.groupRows));
    if (rows.length > 0) parts.push(rows.map(rowLine).join('\n'));
  }
  return parts.length > 0 ? `The server:\n${parts.join('\n')}` : '';
}
