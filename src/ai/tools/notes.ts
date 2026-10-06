// Memory v2 notes tools (docs/memory.md): the chat model's "ls" / "cat" / "grep" over its notes on people,
// the group, circles and occasions (archived ones included: they stay readable as a historical trace), and
// record_correction, which files a correction in the journal right away (shown next to the notes from then
// on, folded in by the nightly dream). Notes are read-only here: only the dream, the owner's edits and the
// bootstrap write them.
import { canonicalUserId } from '../../linkedAccounts';
import { logger } from '../../logger';
import { getMemoryStore, getNotesStore } from '../memory';
import { evidenceFromMessage } from '../memory/evidence';
import { CORRECTION_CATEGORY, type MemoryStore } from '../memory/memoryStore';
import {
  circlesNamedIn,
  correctionLine,
  describeMembers,
  describeParticipants,
  formatNoteSize,
  GROUP_CORRECTIONS_HEADING,
  journalLine,
  membershipSpan,
  renderCorrections,
} from '../memory/notes/context';
import { byOccasionRelevance, describePhase, isArchived, occasionDates } from '../memory/notes/lifecycle';
import type { Note, NotesStore } from '../memory/notes/notesStore';
import { normalizeTopic, PROFILE_TOPIC } from '../memory/notes/schema';
import { buildPeopleDirectory, currentName, type ResolvedPerson, requesterOf, resolvePersonRef } from '../people';
import type { ToolDefinition, ToolHandlerContext } from '../types';
import { formatRelativeAge } from '../utils';

/** Words that mean the server as a whole rather than a person. */
const GROUP_WORDS = new Set(['group', 'the group', 'server', 'the server', 'everyone', 'us', 'all of us', 'the gang']);
/** The longest correction record_correction files (one or two sentences). */
export const MAX_CORRECTION_CHARS = 400;
/**
 * Corrections one member may file in a rolling 24 hours. Each one can pull a person into the nightly dream
 * (a strong-model call), so a spammer can't inflate the bill; real corrections are a handful a week.
 */
export const MAX_CORRECTIONS_PER_DAY = 15;
const SEARCH_LIMIT = 8;
const OPEN_ITEMS_SHOWN = 10;

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isGroupRef(ref: string): boolean {
  return GROUP_WORDS.has(ref.toLowerCase().replace(/\s+/g, ' '));
}

function nameOf(store: MemoryStore): (userId: string) => string | undefined {
  return (id) => currentName(id, '', store) || undefined;
}

/** "3.2k chars, updated 2d ago by the dream" for a listing line. */
function noteStats(note: Note, now: Date): string {
  const age = formatRelativeAge(note.updatedAt, now);
  return `${formatNoteSize(note.content.length)}${age ? `, updated ${age}` : ''}`;
}

/** A person by any name / @mention / "me", or the explanation the model can act on. */
function resolveMember(
  ctx: ToolHandlerContext,
  ref: string,
): { ok: true; person: ResolvedPerson } | { ok: false; error: string } {
  return resolvePersonRef(ref, buildPeopleDirectory(ctx.message));
}

/** A shared note by slug, title or alias (case-insensitive) among `candidates`, live ones before archived. */
function findShared(bySlug: Note | undefined, candidates: Note[], ref: string): Note | undefined {
  if (bySlug) return bySlug;
  const sorted = [...candidates].sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)));
  const exact = sorted.find(
    (c) => c.title.toLowerCase() === ref.toLowerCase() || c.aliases.some((a) => a.toLowerCase() === ref.toLowerCase()),
  );
  return exact ?? circlesNamedIn(ref, sorted)[0];
}

/** A circle by slug, title or alias (case-insensitive), archived ones included. */
function findCircle(notes: NotesStore, ref: string): Note | undefined {
  return findShared(notes.getCircle(ref), notes.listCircles({ includeArchived: true }), ref);
}

/** An occasion by slug, title or alias (case-insensitive), archived ones included. */
function findOccasion(notes: NotesStore, ref: string): Note | undefined {
  return findShared(notes.getOccasion(ref), notes.listOccasions({ includeArchived: true }), ref);
}

function circleHeader(circle: Note, store: MemoryStore, now: Date): string {
  const age = formatRelativeAge(circle.updatedAt, now);
  const aliases = circle.aliases.length > 0 ? `; also called ${circle.aliases.join(', ')}` : '';
  const archived = isArchived(circle) ? 'archived ' : '';
  return `${circle.title} (${archived}circle "${circle.topic}"${aliases}; members: ${describeMembers(circle.members, nameOf(store)) || 'none'}; v${circle.version}${age ? `, updated ${age}` : ''} by ${circle.updatedBy})`;
}

function occasionHeader(occasion: Note, store: MemoryStore, now: Date, today: string): string {
  const age = formatRelativeAge(occasion.updatedAt, now);
  const aliases = occasion.aliases.length > 0 ? `; also called ${occasion.aliases.join(', ')}` : '';
  const where = occasion.place ? ` in ${occasion.place}` : '';
  return `${occasion.title} (occasion "${occasion.topic}"${aliases}; ${occasionDates(occasion)}${where}; ${describePhase(occasion, today)}; participants: ${describeParticipants(occasion.members, nameOf(store)) || 'none'}; v${occasion.version}${age ? `, updated ${age}` : ''} by ${occasion.updatedBy})`;
}

/** An occasion as one listing line: `- ski-trip-2027: "Ski trip" (planned, starts in 9 days; 2027-01-10 to …; 1.2k chars)`. */
function occasionListLine(occasion: Note, now: Date, today: string, place?: string): string {
  return `- ${occasion.topic}: "${occasion.title}" (${describePhase(occasion, today)}; ${occasionDates(occasion)}${occasion.place ? ` in ${occasion.place}` : ''}${place ? `; ${place}` : ''}; ${noteStats(occasion, now)})`;
}

// ---- list_notes ----

function listFor(notes: NotesStore, person: ResolvedPerson, now: Date): string {
  const owner = { scope: 'person' as const, ownerId: person.userId };
  const today = notes.today();
  const topics = notes.listNotes(owner);
  const circles = notes.circlesOf(person.userId, { includeFormer: true, includeArchived: true });
  const occasions = notes
    .occasionsOf(person.userId, { includeFormer: true, includeArchived: true })
    .sort((a, b) => byOccasionRelevance(today)(a.occasion, b.occasion));
  const pending = notes.newJournal({ ...owner, names: person.names });
  const corrections = pending.filter((m) => m.category === CORRECTION_CATEGORY).length;
  const lines: string[] = [];
  if (topics.length === 0) {
    lines.push(
      `No notes on ${person.displayName} yet (the nightly dream writes them). recall_memories searches what you've picked up about them.`,
    );
  } else {
    lines.push(`Notes on ${person.displayName}:`);
    for (const note of topics) lines.push(`- ${note.topic}: "${note.title}" (${noteStats(note, now)})`);
  }
  if (circles.length > 0) {
    lines.push('Circles:');
    for (const { circle, membership } of circles) {
      const span = membershipSpan(membership);
      const status = isArchived(circle) ? 'archived, ' : membership.until === null ? '' : 'former member, ';
      lines.push(`- ${circle.topic}: "${circle.title}" (${status}${span ? `${span}, ` : ''}${noteStats(circle, now)})`);
    }
  }
  if (occasions.length > 0) {
    lines.push('Occasions:');
    for (const { occasion, membership } of occasions) {
      const place = [membership.role ?? '', membership.until ? `dropped out ${membership.until}` : '']
        .filter((p) => p)
        .join(', ');
      lines.push(occasionListLine(occasion, now, today, place || undefined));
    }
  }
  if (pending.length > 0) {
    lines.push(
      `Newer than the notes: ${pending.length} journal entr${pending.length === 1 ? 'y' : 'ies'}${corrections > 0 ? ` (${corrections} correction${corrections === 1 ? '' : 's'})` : ''}.`,
    );
  }
  return lines.join('\n');
}

function listEveryone(notes: NotesStore, store: MemoryStore, now: Date): string {
  const all = notes.listAllNotes();
  const lines: string[] = [];
  const people = new Map<string, Note[]>();
  for (const note of all) {
    if (note.scope !== 'person' || !note.ownerId) continue;
    people.set(note.ownerId, [...(people.get(note.ownerId) ?? []), note]);
  }
  if (people.size > 0) {
    lines.push('People:');
    const rows = [...people.entries()]
      .map(([id, list]) => ({ name: currentName(id, id, store), list }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const { name, list } of rows) {
      const profile = list.find((n) => n.topic === PROFILE_TOPIC);
      const age = profile ? formatRelativeAge(profile.updatedAt, now) : '';
      lines.push(`- ${name}: ${list.map((n) => n.topic).join(', ')}${age ? ` (profile updated ${age})` : ''}`);
    }
  }
  const group = all.filter((n) => n.scope === 'group');
  if (group.length > 0) {
    lines.push('The group:');
    for (const note of group) lines.push(`- ${note.topic}: "${note.title}" (${noteStats(note, now)})`);
  }
  const circles = all.filter((n) => n.scope === 'circle').sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)));
  if (circles.length > 0) {
    lines.push('Circles:');
    for (const circle of circles) {
      const members = circle.members
        .filter((m) => m.until === null)
        .map((m) => currentName(m.memberId, 'someone', store));
      const who = isArchived(circle) ? 'archived' : members.join(', ') || 'no current members';
      lines.push(`- ${circle.topic}: "${circle.title}" (${who})`);
    }
  }
  const today = notes.today();
  const occasions = all.filter((n) => n.scope === 'occasion').sort(byOccasionRelevance(today));
  if (occasions.length > 0) {
    lines.push('Occasions:');
    for (const occasion of occasions) lines.push(occasionListLine(occasion, now, today));
  }
  return lines.length > 0 ? lines.join('\n') : 'No notes yet: the nightly dream writes them from what you pick up.';
}

const listNotesTool: ToolDefinition = {
  name: 'list_notes',
  description:
    "List your notes: for one person, their topics (profile, games, work, …) with size and age, their circles (groups and pairs they belong to: the MTG crew, two best friends) and their occasions (trips, outings and other one-off things they do with others, upcoming first); without a person, everyone who has notes, the group's topics, every circle and every occasion. Archived circles and occasions are history kept as a short trace. Use it to see what you know before reading a note.",
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'Whose notes: any name they go by, an @mention, "me", or "group". Omit for everyone.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const notes = getNotesStore(store);
    const now = new Date();
    const ref = text(args.person);
    if (!ref) return listEveryone(notes, store, now);
    if (isGroupRef(ref)) {
      const group = notes.listNotes({ scope: 'group' });
      if (group.length === 0) return 'No group notes yet.';
      return `The group's notes:\n${group.map((n) => `- ${n.topic}: "${n.title}" (${noteStats(n, now)})`).join('\n')}`;
    }
    const resolved = resolveMember(ctx, ref);
    if (!resolved.ok) return resolved.error;
    return listFor(notes, resolved.person, now);
  },
};

// ---- read_note ----

function readCircle(circle: Note, store: MemoryStore, now: Date): string {
  return `${circleHeader(circle, store, now)}\n\n${circle.content}`;
}

function readOccasion(occasion: Note, store: MemoryStore, now: Date, today: string): string {
  return `${occasionHeader(occasion, store, now, today)}\n\n${occasion.content}`;
}

/** A circle or an occasion read in full. */
function readShared(note: Note, notes: NotesStore, store: MemoryStore, now: Date): string {
  return note.scope === 'occasion' ? readOccasion(note, store, now, notes.today()) : readCircle(note, store, now);
}

function readPersonNote(
  notes: NotesStore,
  store: MemoryStore,
  person: ResolvedPerson,
  topic: string,
  now: Date,
): string {
  const owner = { scope: 'person' as const, ownerId: person.userId };
  const note = notes.getNote(owner, topic);
  if (!note) {
    // A topic that is one of their circles or occasions reads it.
    const isTheirs = (shared: Note | undefined) => shared?.members.some((m) => m.memberId === person.userId);
    const circle = notes.getCircle(topic);
    if (circle && isTheirs(circle)) return readCircle(circle, store, now);
    const occasion = notes.getOccasion(topic);
    if (occasion && isTheirs(occasion)) return readOccasion(occasion, store, now, notes.today());
    const topics = notes.listNotes(owner).map((n) => n.topic);
    const circles = notes
      .circlesOf(person.userId, { includeFormer: true, includeArchived: true })
      .map((c) => c.circle.topic);
    const occasions = notes
      .occasionsOf(person.userId, { includeFormer: true, includeArchived: true })
      .map((o) => o.occasion.topic);
    if (topics.length === 0 && circles.length === 0 && occasions.length === 0) {
      return `No notes on ${person.displayName} yet (the nightly dream writes them). recall_memories searches what you've picked up about them.`;
    }
    return `${person.displayName} has no "${topic}" note. Topics: ${topics.join(', ') || 'none'}${circles.length > 0 ? `; circles: ${circles.join(', ')}` : ''}${occasions.length > 0 ? `; occasions: ${occasions.join(', ')}` : ''}.`;
  }
  const age = formatRelativeAge(note.updatedAt, now);
  const lines = [
    `${person.displayName} · ${note.title} (v${note.version}${age ? `, updated ${age}` : ''} by ${note.updatedBy})`,
    '',
    note.content,
  ];
  if (topic === PROFILE_TOPIC) {
    const journalOwner = { ...owner, names: person.names };
    const pending = notes.newJournal(journalOwner, { kinds: 'observations', limit: OPEN_ITEMS_SHOWN });
    const corrections = notes.openCorrections(journalOwner, OPEN_ITEMS_SHOWN);
    if (pending.length > 0) lines.push('', 'Newer than this note:', ...pending.map((m) => journalLine(m, now)));
    if (corrections.length > 0) {
      lines.push(
        '',
        ...renderCorrections(
          corrections,
          {
            own: 'Their own corrections, newer than this note (they win over it):',
            claims:
              "What others claim about them, newer than this note (their word, not settled: don't repeat it as fact):",
          },
          (m) => correctionLine(m, nameOf(store), now),
        ),
      );
    }
  }
  return lines.join('\n');
}

const readNoteTool: ToolDefinition = {
  name: 'read_note',
  description:
    'Read one of your notes in full, including its dated "Earlier" history the context note leaves out: a person\'s topic (default their profile), a group topic, a circle, or an occasion (a trip, an outing: its plan, or what happened). Circles and occasions are found by slug, title or another name for them, archived ones too. list_notes shows what exists.',
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description:
          'Whose note: any name they go by, an @mention, "me", or "group". Omit when reading a circle or an occasion.',
      },
      topic: {
        type: 'string',
        description: 'The topic slug, e.g. "profile", "games", "running-jokes". Default "profile".',
      },
      circle: { type: 'string', description: 'A circle: its slug (e.g. "mtg"), title or another name for it.' },
      occasion: {
        type: 'string',
        description: 'An occasion: its slug (e.g. "ski-trip-2027"), title ("Ski trip") or another name for it.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const notes = getNotesStore(store);
    const now = new Date();
    const circleRef = text(args.circle);
    const occasionRef = text(args.occasion);
    const ref = text(args.person);
    const rawTopic = text(args.topic);
    const topic = rawTopic ? normalizeTopic(rawTopic) : PROFILE_TOPIC;

    // A circle or an occasion asked for by name: the kind asked for first, then the other (the model mixes
    // them up: "the ski trip" asked for as a circle still reads the occasion).
    const sharedRef = occasionRef || circleRef || (!ref && rawTopic ? rawTopic : '');
    if (sharedRef) {
      const found = occasionRef
        ? (findOccasion(notes, sharedRef) ?? findCircle(notes, sharedRef))
        : (findCircle(notes, sharedRef) ?? findOccasion(notes, sharedRef));
      if (found) return readShared(found, notes, store, now);
      const circles = notes.listCircles({ includeArchived: true }).map((c) => c.topic);
      const occasions = notes.listOccasions({ includeArchived: true }).map((o) => o.topic);
      return `No circle or occasion "${sharedRef}". Circles: ${circles.join(', ') || 'none yet'}. Occasions: ${occasions.join(', ') || 'none yet'}.`;
    }
    if (!ref) return 'Say whose note (person, or "group") or which circle.';
    if (!topic) return `"${rawTopic}" is not a topic: topics are lowercase slugs like "profile" or "running-jokes".`;

    if (isGroupRef(ref)) {
      const note = notes.getNote({ scope: 'group' }, topic === PROFILE_TOPIC ? 'lore' : topic);
      if (!note) {
        const topics = notes.listNotes({ scope: 'group' }).map((n) => n.topic);
        return `No group note "${topic}". Group topics: ${topics.join(', ') || 'none yet'}.`;
      }
      const age = formatRelativeAge(note.updatedAt, now);
      const lines = [
        `The group · ${note.title} (v${note.version}${age ? `, updated ${age}` : ''} by ${note.updatedBy})`,
        '',
        note.content,
      ];
      const corrections = notes.openCorrections({ scope: 'group' }, OPEN_ITEMS_SHOWN);
      if (corrections.length > 0) {
        lines.push('', GROUP_CORRECTIONS_HEADING, ...corrections.map((m) => correctionLine(m, nameOf(store), now)));
      }
      return lines.join('\n');
    }
    const resolved = resolveMember(ctx, ref);
    if (!resolved.ok) return resolved.error;
    return readPersonNote(notes, store, resolved.person, topic, now);
  },
};

// ---- search_notes ----

const searchNotesTool: ToolDefinition = {
  name: 'search_notes',
  description:
    'Keyword search across all your notes (people, the group, circles, occasions; archived ones too), older dated history included. Returns which note matched with a snippet; read_note opens it. For raw details and exact wording, recall_memories searches the journal.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'A few distinctive words.' } },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (_ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const query = text(args.query);
    if (!query) return 'Give a few words to search for.';
    const store = getMemoryStore();
    const hits = getNotesStore(store).searchNotes(query, { limit: SEARCH_LIMIT });
    if (hits.length === 0) return `No notes mention "${query}". recall_memories searches the raw journal.`;
    const lines = hits.map(({ note, snippet }) => {
      const archived = isArchived(note) ? 'archived ' : '';
      const where =
        note.scope === 'circle' || note.scope === 'occasion'
          ? `${archived}${note.scope} "${note.title}" (${note.scope}: ${note.topic})`
          : note.scope === 'group'
            ? `the group · ${note.topic}`
            : `${currentName(note.ownerId ?? '', 'someone', store)} · ${note.topic}`;
      return `- ${where}: ${snippet}`;
    });
    return `Notes matching "${query}":\n${lines.join('\n')}`;
  },
};

// ---- record_correction ----

/**
 * Files a correction in the journal: what is wrong and what is right about someone (or the group), who
 * said it (the requester's main id in `said_by`), and the message it came from as evidence. Returns the
 * row id.
 */
export async function recordCorrection(args: {
  store: MemoryStore;
  about: ResolvedPerson | 'group';
  correction: string;
  saidBy: string;
  messageId?: string;
  quote?: string;
}): Promise<number> {
  const about = args.about;
  return args.store.save({
    category: CORRECTION_CATEGORY,
    subject: about === 'group' ? 'server' : about.displayName,
    content: args.correction,
    source: 'correction',
    subject_user_id: about === 'group' ? undefined : about.userId,
    said_by: canonicalUserId(args.saidBy),
    evidence: evidenceFromMessage(args.messageId, args.quote),
  });
}

/**
 * Corrections this speaker (any account; their main id is used) filed or re-filed in the last 24 hours,
 * forgotten ones included. Measured on SQLite's clock, like the rows' own timestamps; a correction merged
 * into an earlier one counts once.
 */
export function recentCorrectionCount(store: MemoryStore, saidBy: string): number {
  const row = store
    .sharedDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM memories
       WHERE category = ? AND said_by = ? AND updated_at >= datetime('now', '-1 day')`,
    )
    .get(CORRECTION_CATEGORY, canonicalUserId(saidBy)) as { n: number };
  return row.n;
}

const recordCorrectionTool: ToolDefinition = {
  name: 'record_correction',
  description: `Record a correction to what you know about someone (or the group) when a person says your notes are wrong or out of date ("I quit Valorant in August", "Dale moved to Laval, not Montreal"). It shows next to your notes right away and is folded into them tonight. Someone correcting themselves is authoritative; a correction about someone else is recorded as that person's claim. Not for jokes or banter. One person can file at most ${MAX_CORRECTIONS_PER_DAY} a day.`,
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'Who it is about: any name they go by, an @mention, "me" (the person talking), or "group".',
      },
      correction: {
        type: 'string',
        description:
          'What is wrong and what is right, in one or two plain sentences ("Quit Valorant in August 2026; plays Deadlock now").',
      },
    },
    required: ['person', 'correction'],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const correction = text(args.correction).replace(/\s+/g, ' ');
    if (!correction) return 'Nothing recorded: the correction was empty.';
    if (correction.length > MAX_CORRECTION_CHARS) {
      return `Nothing recorded: keep a correction under ${MAX_CORRECTION_CHARS} characters (one or two sentences).`;
    }
    const ref = text(args.person) || 'me';
    const store = getMemoryStore();
    const requester = requesterOf(ctx.message);
    let about: ResolvedPerson | 'group';
    if (isGroupRef(ref)) about = 'group';
    else {
      const resolved = resolveMember(ctx, ref);
      if (!resolved.ok) return `Nothing recorded. ${resolved.error}`;
      about = resolved.person;
    }
    // Checked right before the save, whose synchronous half (the INSERT) runs before anything else can.
    if (recentCorrectionCount(store, requester.userId) >= MAX_CORRECTIONS_PER_DAY) {
      logger.info(`record_correction: ${requester.userId} is at the cap (${MAX_CORRECTIONS_PER_DAY} per 24 h)`);
      return `Nothing recorded: ${requester.displayName} has already filed ${MAX_CORRECTIONS_PER_DAY} corrections in the last 24 hours, the most you take from one person in a day. Tell them, in your own voice, that you're done taking corrections from them for today and they can try again tomorrow.`;
    }
    let id: number;
    try {
      id = await recordCorrection({
        store,
        about,
        correction,
        saidBy: requester.userId,
        messageId: ctx.message.id,
        quote: ctx.message.content,
      });
    } catch (error) {
      logger.warn('record_correction: saving failed:', error);
      return 'Nothing recorded: saving failed.';
    }
    const target = about === 'group' ? 'the group' : about.displayName;
    logger.info(`record_correction: #${id} about ${target} from ${requester.userId}`);
    if (about !== 'group' && canonicalUserId(requester.userId) === about.userId) {
      return `Recorded (id: ${id}) as ${about.displayName}'s own correction: it's authoritative and shows next to your notes on them from now on; tonight's dream folds it in.`;
    }
    return `Recorded (id: ${id}) as ${requester.displayName}'s claim about ${target}: it shows next to your notes, and tonight's dream weighs it against what else you know${about === 'group' ? '' : ` (${about.displayName}'s own word would win)`}.`;
  },
};

export const notesTools: ToolDefinition[] = [listNotesTool, readNoteTool, searchNotesTool, recordCorrectionTool];
