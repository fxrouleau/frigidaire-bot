// Memory v2 notes tools (docs/memory.md): the chat model's "ls" / "cat" / "grep" over its notes on people,
// the group and circles, and record_correction, which files a correction in the journal right away (shown
// next to the notes from then on, folded in by the nightly dream). Notes are read-only here: only the
// dream, the owner's edits and the bootstrap write them.
import { canonicalUserId } from '../../linkedAccounts';
import { logger } from '../../logger';
import { getMemoryStore, getNotesStore } from '../memory';
import { evidenceFromMessage } from '../memory/evidence';
import { CORRECTION_CATEGORY, type MemoryStore } from '../memory/memoryStore';
import {
  circlesNamedIn,
  correctionLine,
  describeMembers,
  formatNoteSize,
  journalLine,
  membershipSpan,
} from '../memory/notes/context';
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

/** A circle by slug, title or alias (case-insensitive), among the active ones. */
function findCircle(notes: NotesStore, ref: string): Note | undefined {
  const bySlug = notes.getCircle(ref);
  if (bySlug) return bySlug;
  const circles = notes.listCircles();
  const exact = circles.find(
    (c) => c.title.toLowerCase() === ref.toLowerCase() || c.aliases.some((a) => a.toLowerCase() === ref.toLowerCase()),
  );
  return exact ?? circlesNamedIn(ref, circles)[0];
}

function circleHeader(circle: Note, store: MemoryStore, now: Date): string {
  const age = formatRelativeAge(circle.updatedAt, now);
  const aliases = circle.aliases.length > 0 ? `; also called ${circle.aliases.join(', ')}` : '';
  return `${circle.title} (circle "${circle.topic}"${aliases}; members: ${describeMembers(circle.members, nameOf(store)) || 'none'}; v${circle.version}${age ? `, updated ${age}` : ''} by ${circle.updatedBy})`;
}

// ---- list_notes ----

function listFor(notes: NotesStore, person: ResolvedPerson, now: Date): string {
  const owner = { scope: 'person' as const, ownerId: person.userId };
  const topics = notes.listNotes(owner);
  const circles = notes.circlesOf(person.userId, { includeFormer: true });
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
      const status = membership.until === null ? '' : 'former member, ';
      lines.push(`- ${circle.topic}: "${circle.title}" (${status}${span ? `${span}, ` : ''}${noteStats(circle, now)})`);
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
  const circles = all.filter((n) => n.scope === 'circle');
  if (circles.length > 0) {
    lines.push('Circles:');
    for (const circle of circles) {
      const members = circle.members
        .filter((m) => m.until === null)
        .map((m) => currentName(m.memberId, 'someone', store));
      lines.push(`- ${circle.topic}: "${circle.title}" (${members.join(', ') || 'no current members'})`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No notes yet: the nightly dream writes them from what you pick up.';
}

const listNotesTool: ToolDefinition = {
  name: 'list_notes',
  description:
    "List your notes: for one person, their topics (profile, games, work, …) with size and age, and their circles (groups and pairs they belong to: the MTG crew, two best friends); without a person, everyone who has notes, the group's topics and every circle. Use it to see what you know before reading a note.",
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
    // A topic that is one of their circles reads the circle.
    const circle = notes.getCircle(topic);
    if (circle?.members.some((m) => m.memberId === person.userId)) return readCircle(circle, store, now);
    const topics = notes.listNotes(owner).map((n) => n.topic);
    const circles = notes.circlesOf(person.userId, { includeFormer: true }).map((c) => c.circle.topic);
    if (topics.length === 0 && circles.length === 0) {
      return `No notes on ${person.displayName} yet (the nightly dream writes them). recall_memories searches what you've picked up about them.`;
    }
    return `${person.displayName} has no "${topic}" note. Topics: ${topics.join(', ') || 'none'}${circles.length > 0 ? `; circles: ${circles.join(', ')}` : ''}.`;
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
        'Corrections newer than this note (they win over it):',
        ...corrections.map((m) => correctionLine(m, nameOf(store), now)),
      );
    }
  }
  return lines.join('\n');
}

const readNoteTool: ToolDefinition = {
  name: 'read_note',
  description:
    'Read one of your notes in full, including its dated "Earlier" history the context note leaves out: a person\'s topic (default their profile), a group topic, or a circle (by its slug, title or another name for it). list_notes shows what exists.',
  parameters: {
    type: 'object',
    properties: {
      person: {
        type: 'string',
        description: 'Whose note: any name they go by, an @mention, "me", or "group". Omit when reading a circle.',
      },
      topic: {
        type: 'string',
        description: 'The topic slug, e.g. "profile", "games", "running-jokes". Default "profile".',
      },
      circle: { type: 'string', description: 'A circle: its slug (e.g. "mtg"), title or another name for it.' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (ctx: ToolHandlerContext, args: Record<string, unknown>) => {
    const store = getMemoryStore();
    const notes = getNotesStore(store);
    const now = new Date();
    const circleRef = text(args.circle);
    const ref = text(args.person);
    const rawTopic = text(args.topic);
    const topic = rawTopic ? normalizeTopic(rawTopic) : PROFILE_TOPIC;

    if (circleRef || (!ref && rawTopic)) {
      const circle = findCircle(notes, circleRef || rawTopic);
      if (circle) return readCircle(circle, store, now);
      const known = notes.listCircles().map((c) => c.topic);
      return `No circle "${circleRef || rawTopic}". Circles: ${known.join(', ') || 'none yet'}.`;
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
      return `The group · ${note.title} (v${note.version}${age ? `, updated ${age}` : ''} by ${note.updatedBy})\n\n${note.content}`;
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
    'Keyword search across all your notes (people, the group, circles), older dated history included. Returns which note matched with a snippet; read_note opens it. For raw details and exact wording, recall_memories searches the journal.',
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
      const where =
        note.scope === 'circle'
          ? `circle "${note.title}" (circle: ${note.topic})`
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
