// How notes reach a model's prompt (memory v2): the chat turn's per-person blocks (profile + the journal
// rows the notes don't reflect yet + open corrections + their circles), circle blocks, the static prompt's
// group section, and the short profile summaries other features use (summaries' WHO'S WHO, the birthday
// writer). Chat turns see a note without its dated "Earlier" footnotes (sections.ts): those come up on
// demand (read_note) or through search. Pure functions over already-loaded rows, so every consumer renders
// notes the same way and tests need no store.
import { canonicalUserId } from '../../../linkedAccounts';
import { formatRelativeAge } from '../../utils';
import { CORRECTION_CATEGORY, type Memory } from '../memoryStore';
import type { CircleMembership, Note } from './notesStore';
import type { CircleMember } from './schema';
import { earlierPart, withoutEarlier } from './sections';

/** The chat turn's cap on the speaker's profile, and on everyone else's. */
export const SPEAKER_PROFILE_MAX_CHARS = 3_000;
export const OTHER_PROFILE_MAX_CHARS = 1_500;
/** Journal rows newer than a person's notes shown per turn (the newest). */
export const NEW_JOURNAL_LIMIT = 10;
/** Open corrections shown per person (the newest). */
export const OPEN_CORRECTIONS_LIMIT = 10;
/** The static prompt's group section, all group notes together. */
export const GROUP_SECTION_MAX_CHARS = 2_500;
/** Group topics the static prompt carries, in this order when present. */
export const GROUP_PROMPT_TOPICS = ['vibe', 'lore'] as const;
/** A circle's note in a chat turn, and how many circles one turn shows at most. */
export const CIRCLE_MAX_CHARS = 1_500;
export const MAX_CIRCLES_PER_TURN = 3;
/** Current members of a circle that must be in the conversation for its note to be shown. */
export const CIRCLE_MIN_PRESENT = 2;

/** A note version's identity in a conversation window: a new version is new, the same one never repeats. */
export function noteKey(note: Pick<Note, 'id' | 'version'>): string {
  return `note:${note.id}@${note.version}`;
}

/**
 * Markdown cut to `maxChars` at the last paragraph (else line, else word) boundary that fits, with an
 * ellipsis line when anything was dropped.
 */
export function excerpt(markdown: string, maxChars: number): string {
  const text = markdown.trim();
  if (text.length <= maxChars) return text;
  const room = Math.max(0, maxChars - 2);
  const head = text.slice(0, room);
  const cut = [head.lastIndexOf('\n\n'), head.lastIndexOf('\n'), head.lastIndexOf(' ')].find((i) => i > room / 2);
  return `${head.slice(0, cut ?? room).trimEnd()}\n…`;
}

/** A note as a chat turn reads it: without its Earlier footnotes, capped. */
export function chatExcerpt(markdown: string, maxChars: number): string {
  return excerpt(withoutEarlier(markdown), maxChars);
}

const EARLIER_HINT = '(Older, dated history in this note is left out here: read_note shows it.)';

/**
 * The first lines of a profile as one plain line (the Earlier footnotes, headings and list markers
 * dropped), for places that only need who someone is at a glance: summaries' WHO'S WHO.
 */
export function profileSummary(markdown: string, maxChars: number): string {
  const lines = withoutEarlier(markdown)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*|__/g, ''));
  const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}

/** A journal row as one dated line: `- [fact] works nights at the bakery (3d ago)`. */
export function journalLine(row: Pick<Memory, 'category' | 'content' | 'updated_at'>, now: Date): string {
  const age = formatRelativeAge(row.updated_at, now);
  return `- [${row.category}] ${row.content}${age ? ` (${age})` : ''}`;
}

type CorrectionRow = Pick<Memory, 'said_by' | 'subject_user_id'>;

/**
 * Whether a correction is the person's own word about themself (authoritative) rather than someone else's
 * claim about them (weighed, never settled). Linked accounts count as one member: a correction filed from
 * an account later linked as a side account stays their own after the startup stamp moved the row's
 * subject to the main account.
 */
export function isSelfCorrection(row: CorrectionRow): boolean {
  return (
    !!row.said_by && !!row.subject_user_id && canonicalUserId(row.said_by) === canonicalUserId(row.subject_user_id)
  );
}

/**
 * A correction as one dated line, naming who said it: `- Dale says: moved to Laval (today)`, or
 * `- Remi, about themself: quit Valorant (today)` when the person corrected their own notes.
 */
export function correctionLine(
  row: Pick<Memory, 'content' | 'updated_at' | 'said_by' | 'subject_user_id'>,
  nameOf: (userId: string) => string | undefined,
  now: Date,
): string {
  const age = formatRelativeAge(row.updated_at, now);
  const when = age ? ` (${age})` : '';
  const speaker = row.said_by ? (nameOf(row.said_by) ?? 'someone') : 'someone';
  if (isSelfCorrection(row)) return `- ${speaker}, about themself: ${row.content}${when}`;
  return `- ${speaker} says: ${row.content}${when}`;
}

/**
 * Where a correction comes from, as a label for lists of several people's journal rows (the chat turn's
 * search hits, recall_memories), whose lines can't say who spoke: `their own word`, or
 * `Remi's claim, not settled`.
 */
export function correctionSource(row: CorrectionRow, nameOf: (userId: string) => string | undefined): string {
  if (isSelfCorrection(row)) return 'their own word';
  const speaker = row.said_by ? (nameOf(row.said_by) ?? 'someone') : 'someone';
  return `${speaker}'s claim, not settled`;
}

/**
 * A journal row's bracketed category for lists of several people's rows: `[fact]`, or for a correction who
 * made it (`[correction, Remi's claim, not settled]`), so a claim about someone never reads as their fact.
 */
export function categoryLabel(
  row: Pick<Memory, 'category' | 'said_by' | 'subject_user_id'>,
  nameOf: (userId: string) => string | undefined,
): string {
  return row.category === CORRECTION_CATEGORY
    ? `[${row.category}, ${correctionSource(row, nameOf)}]`
    : `[${row.category}]`;
}

/** The headings of a person's open corrections, one per weight (see renderCorrections). */
export type CorrectionHeadings = { own: string; claims: string };

/**
 * A person's open corrections as heading + lines, split by weight: their own first (they win over the
 * notes), then what others claim about them (their word, weighed by the dream, never settled). A kind with
 * no rows is left out; each keeps its rows' order.
 */
export function renderCorrections<T extends CorrectionRow>(
  rows: T[],
  headings: CorrectionHeadings,
  line: (row: T) => string,
): string[] {
  const own = rows.filter(isSelfCorrection);
  const claims = rows.filter((row) => !isSelfCorrection(row));
  return [
    ...(own.length > 0 ? [headings.own, ...own.map(line)] : []),
    ...(claims.length > 0 ? [headings.claims, ...claims.map(line)] : []),
  ];
}

/** A membership span: `since 2021`, `2021–2023-02`, `until 2023`, or ''. */
export function membershipSpan(member: Pick<CircleMember, 'since' | 'until'>): string {
  if (member.since && member.until) return `${member.since}–${member.until}`;
  if (member.since) return `since ${member.since}`;
  if (member.until) return `until ${member.until}`;
  return '';
}

/**
 * A circle's members as one line: current members, then former ones, with their spans and roles:
 * `Remi (since 2021, organizer), Nova (since 2024); formerly Dale (2021–2023-02)`.
 */
export function describeMembers(members: CircleMember[], nameOf: (userId: string) => string | undefined): string {
  const label = (m: CircleMember) => {
    const details = [membershipSpan(m), m.role ?? ''].filter((d) => d).join(', ');
    const name = nameOf(m.memberId) ?? 'someone';
    return details ? `${name} (${details})` : name;
  };
  const current = members.filter((m) => m.until === null).map(label);
  const former = members.filter((m) => m.until !== null).map(label);
  return [current.join(', '), former.length > 0 ? `formerly ${former.join(', ')}` : '']
    .filter((part) => part)
    .join('; ');
}

/** A member's current circles as one line for their notes block (`The MTG crew, Remi & Dale`), or ''. */
export function circlesLine(circles: CircleMembership[]): string {
  const current = circles.filter((c) => c.membership.until === null).map((c) => c.circle.title);
  return current.length > 0 ? `Their circles: ${current.join(', ')}.` : '';
}

export type PersonNotesBlock = {
  /** The block's first line, e.g. "What you know about the person talking to you right now (Remi):". */
  heading: string;
  name: string;
  /** Their profile, or undefined when this window already has this version. */
  profile?: Note;
  profileMaxChars: number;
  /** Their circles (shown with the profile). */
  circles?: CircleMembership[];
  /** Journal rows newer than the notes (not yet shown this window), oldest first. */
  journal: Memory[];
  /** Open corrections (not yet shown this window), oldest first. */
  corrections: Memory[];
  nameOf: (userId: string) => string | undefined;
  now: Date;
};

/** One person's notes context for a chat turn; '' when there is nothing new to show. */
export function renderPersonNotes(block: PersonNotesBlock): string {
  const parts: string[] = [];
  if (block.profile) {
    const age = formatRelativeAge(block.profile.updatedAt, block.now);
    const body = chatExcerpt(block.profile.content, block.profileMaxChars);
    const extras = [circlesLine(block.circles ?? []), earlierPart(block.profile.content) ? EARLIER_HINT : '']
      .filter((line) => line)
      .join('\n');
    parts.push(`Your notes on ${block.name}${age ? ` (updated ${age})` : ''}:\n${body}${extras ? `\n${extras}` : ''}`);
  }
  if (block.journal.length > 0) {
    parts.push(
      `Newer than your notes on ${block.name}:\n${block.journal.map((r) => journalLine(r, block.now)).join('\n')}`,
    );
  }
  if (block.corrections.length > 0) {
    parts.push(
      renderCorrections(
        block.corrections,
        {
          own: `${block.name}'s own corrections, newer than your notes (they win over the notes):`,
          claims: `What others claim about ${block.name}, newer than your notes (their word, not settled: don't repeat it as fact):`,
        },
        (r) => correctionLine(r, block.nameOf, block.now),
      ).join('\n'),
    );
  }
  if (parts.length === 0) return '';
  return `${block.heading}\n${parts.join('\n')}`;
}

/** Why a circle's note is in a chat turn. */
export type CircleReason = 'members' | 'named';

/**
 * A circle's note for a chat turn: its title, members and why it is shown, then the note without its
 * Earlier footnotes, capped.
 */
export function renderCircleNote(args: {
  circle: Note;
  reason: CircleReason;
  maxChars: number;
  nameOf: (userId: string) => string | undefined;
  now: Date;
}): string {
  const { circle } = args;
  const age = formatRelativeAge(circle.updatedAt, args.now);
  const why =
    args.reason === 'named' ? 'it came up in this message' : 'several of its members are in this conversation';
  const members = describeMembers(circle.members, args.nameOf);
  const hint = earlierPart(circle.content) ? `\n${EARLIER_HINT}` : '';
  return `Your notes on the circle "${circle.title}" (${why}; members: ${members || 'none listed'}${age ? `; updated ${age}` : ''}):\n${chatExcerpt(circle.content, args.maxChars)}${hint}`;
}

/** Text folded for name matching: lowercase, accents dropped, anything but letters and digits a space. */
export function foldForMatch(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

/** The names a circle is matched by: its title (with and without a leading "the"), its slug as words, its aliases. */
export function circleNames(circle: Pick<Note, 'title' | 'topic' | 'aliases'>): string[] {
  const names = [
    circle.title,
    circle.title.replace(/^the\s+/i, ''),
    circle.topic.replace(/-/g, ' '),
    ...circle.aliases,
  ];
  return [...new Set(names.map((n) => foldForMatch(n).trim()).filter((n) => n.length >= 3))];
}

/** The circles a piece of text names (title, slug words or alias, as whole words), in the given order. */
export function circlesNamedIn<T extends Pick<Note, 'title' | 'topic' | 'aliases'>>(text: string, circles: T[]): T[] {
  const folded = foldForMatch(text);
  if (folded.trim().length === 0) return [];
  return circles.filter((circle) => circleNames(circle).some((name) => folded.includes(` ${name} `)));
}

/**
 * Which circles a chat turn shows, best first, at most `max`: the ones the message names, then the ones
 * with at least CIRCLE_MIN_PRESENT current members among `present` (the speaker, the people mentioned or
 * named, the window's recent participants), most present members first. Circles in `skip` (already shown
 * this window) are left out.
 */
export function pickCircles(args: {
  circles: Note[];
  text: string;
  present: ReadonlySet<string>;
  skip?: (circle: Note) => boolean;
  max?: number;
}): { circle: Note; reason: CircleReason }[] {
  const max = args.max ?? MAX_CIRCLES_PER_TURN;
  const candidates = args.circles.filter((c) => !args.skip?.(c));
  const named = circlesNamedIn(args.text, candidates).map((circle) => ({ circle, reason: 'named' as const }));
  const byPresence = candidates
    .filter((c) => !named.some((n) => n.circle.id === c.id))
    .map((circle) => ({
      circle,
      present: circle.members.filter((m) => m.until === null && args.present.has(m.memberId)).length,
    }))
    .filter((c) => c.present >= CIRCLE_MIN_PRESENT)
    .sort((a, b) => b.present - a.present || a.circle.title.localeCompare(b.circle.title))
    .map(({ circle }) => ({ circle, reason: 'members' as const }));
  return [...named, ...byPresence].slice(0, max);
}

/**
 * The static prompt's group section: the group's vibe and lore notes (GROUP_PROMPT_TOPICS, in that order,
 * without their Earlier footnotes), within GROUP_SECTION_MAX_CHARS. Undated on purpose: the static prompt
 * must stay byte-identical for a whole conversation window, and group notes change at most nightly. ''
 * when there are none.
 */
export function renderGroupSection(groupNotes: Note[]): { text: string; notes: Note[] } {
  const picked = GROUP_PROMPT_TOPICS.map((topic) => groupNotes.find((n) => n.topic === topic)).filter(
    (n): n is Note => n !== undefined,
  );
  if (picked.length === 0) return { text: '', notes: [] };
  const share = Math.floor(GROUP_SECTION_MAX_CHARS / picked.length);
  const body = picked.map((note) => `### ${note.title}\n${chatExcerpt(note.content, share)}`).join('\n\n');
  return {
    text: `\nWhat you know about this group (your notes on the server's vibe and lore):\n${body}\n`,
    notes: picked,
  };
}

/** A note's size for listings: `640 chars`, `3.2k chars`. */
export function formatNoteSize(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`;
}
