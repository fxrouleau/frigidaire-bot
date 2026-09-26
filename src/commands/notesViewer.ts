// The notes viewer behind "What does Fridge know?" (memory v2, docs/memory.md "Viewer and owner edits"):
// a private message showing one note at a time — a person's `profile` first, a select menu of their other
// topics and their circles, Prev/Next when a note is longer than one page, a footer with the version, its
// age and who last changed it. Right-clicking the bot shows the group's notes (and every circle). People
// without notes yet see the raw memory list (the journal) instead, which stays one pick away for everyone
// else too (its ids are what forget_memory takes).
//
// The owner also gets Edit (a modal: "What should change?" → the edit model drafts it → a before/after
// preview → Confirm/Cancel) and Undo (the shown note back to its previous version); the handlers live in
// notesViewerActions.ts and re-check the owner on every click.
//
// Everything a click needs is in the component's custom_id (≤ 100 chars): the subject (a person's main id or
// the group), the screen (a note id or the journal), the page and when it was issued, so the viewer holds no
// state between clicks — except a drafted edit, held in memory for its 15 minutes. A viewer's buttons stop
// working 15 minutes after its last render (said in character). This module is pure rendering: it reads
// the stores and returns message payloads.
import {
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIEmbedField,
  type APIModalInteractionResponseCallbackData,
  type APISelectMenuOption,
  ButtonStyle,
  ComponentType,
  escapeMarkdown,
  TextInputStyle,
} from 'discord.js';
import { type Memory, type MemoryStore, SELF_DIAGNOSIS_CATEGORIES } from '../ai/memory/memoryStore';
import { correctionLine, describeMembers, formatNoteSize, membershipSpan } from '../ai/memory/notes/context';
import type { ProposedChange } from '../ai/memory/notes/dreamer';
import type { CircleMembership, Note, NotesStore } from '../ai/memory/notes/notesStore';
import { type CircleMember, type NoteUpdatedBy, PROFILE_TOPIC } from '../ai/memory/notes/schema';
import { currentName, memoryKeyFor } from '../ai/people';
import { formatRelativeAge } from '../ai/utils';
import { renderDiff } from './noteDiff';

/** How long a viewer's buttons (and a drafted edit) stay usable after their last render. */
export const VIEWER_TTL_MS = 15 * 60_000;
/** One page of a note: an embed description holds 4,096 characters, the rest is room for its fields. */
export const PAGE_CHARS = 3_800;
/** The modal's text input and its limit. */
export const INSTRUCTION_INPUT_ID = 'instruction';
export const MAX_INSTRUCTION_CHARS = 4_000;
/** Discord's limits the viewer has to respect. */
export const DISCORD_LIMITS = {
  customId: 100,
  selectOptions: 25,
  optionText: 100,
  embedTitle: 256,
  embedDescription: 4_096,
  fieldValue: 1_024,
  embedTotal: 6_000,
  modalTitle: 45,
} as const;

const ID_PREFIX = 'nv';
// Enough to page through everything about one person without an unbounded read.
const JOURNAL_FETCH_LIMIT = 1_000;
const MAX_MEMORY_CHARS = 200;
const CORRECTIONS_SHOWN = 5;
// The preview's diff, within one embed next to its membership fields.
const PREVIEW_DIFF_CHARS = 3_900;
const SELF_DIAGNOSIS: ReadonlySet<string> = new Set(SELF_DIAGNOSIS_CATEGORIES);

/** Who last changed a note, as the footer says it. */
const WRITERS: Record<NoteUpdatedBy, string> = {
  dream: 'the nightly dream',
  edit: 'an owner edit',
  bootstrap: 'the bootstrap',
  import: 'an import',
  undo: 'an undo',
};

/** The viewer's in-character lines. */
export const VIEWER_LINES = {
  expired: "this viewer's gone stale (they only last 15 minutes), right-click them again",
  ownerOnly: 'hands off, only the boss edits my notes',
  ownerUnknown: "couldn't check who's asking just now, try that again in a sec",
  drafting: '✏️ drafting that edit… give me a minute',
  draftFailed: "couldn't draft that edit, my pen broke. try again in a bit",
  draftExpired: 'that draft went stale (I only hold them for 15 minutes, and not across restarts). hit Edit again',
  changedSince: 'those notes changed since I drafted that, so I saved nothing. hit Edit again for a fresh draft',
  noChange: "that draft didn't change anything",
  cancelled: 'dropped it, nothing changed',
  noteGone: "that note's gone (removed or merged), here's what's left",
  undoStale: "that note changed since you opened it, so I didn't undo anything. here's the latest",
  emptyInstruction: 'you have to tell me what to change',
  noGroupNotes: 'no group notes yet, the nightly dream writes them',
} as const;

export const nothingKnownLine = (name: string) => `I've got nothing on ${escapeMarkdown(name)} yet`;

/**
 * How long the owner check may take before the viewer answers without it: Discord wants a response within
 * 3 seconds, and the first check after startup fetches the application's owner.
 */
export const OWNER_CHECK_TIMEOUT_MS = 1_500;

/**
 * The owner check's answer, or undefined when it doesn't come in time (the check keeps running and its
 * result is cached for the next click). A failing check reads as "not the owner".
 */
export async function ownerWithin(check: Promise<boolean>, ms = OWNER_CHECK_TIMEOUT_MS): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([check.catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- State and custom ids ----

/** Whose notes: a person (main account id) or the group (right-clicking the bot). */
export type ViewerSubject = { kind: 'person'; id: string } | { kind: 'group' };
/** What is shown: the subject's first note, one note (a topic or a circle) by id, or a person's raw memories. */
export type ViewerScreen = { kind: 'home' } | { kind: 'note'; noteId: number } | { kind: 'journal' };
export type ViewerState = { subject: ViewerSubject; screen: ViewerScreen; page: number };

/** A click the viewer understands, decoded from a component's custom_id. `issuedAt` is epoch seconds. */
export type ViewerAction =
  | { action: 'select'; subject: ViewerSubject; issuedAt: number }
  | { action: 'page'; subject: ViewerSubject; screen: ViewerScreen; page: number; issuedAt: number }
  | { action: 'edit'; subject: ViewerSubject; screen: ViewerScreen; issuedAt: number }
  | { action: 'modal'; subject: ViewerSubject; screen: ViewerScreen }
  | { action: 'undo'; subject: ViewerSubject; noteId: number; version: number; issuedAt: number }
  | { action: 'confirm' | 'cancel'; token: string; issuedAt: number }
  | { action: 'preview'; token: string; page: number; issuedAt: number };

const PERSON_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TOKEN = /^[A-Za-z0-9_-]{4,32}$/;
const COUNT = /^\d{1,12}$/;
const TIME = /^[0-9a-z]{1,10}$/;

function encodeSubject(subject: ViewerSubject): string {
  return subject.kind === 'group' ? 'g' : `p${subject.id}`;
}

function decodeSubject(raw: string): ViewerSubject | undefined {
  if (raw === 'g') return { kind: 'group' };
  const id = raw.slice(1);
  return raw.startsWith('p') && PERSON_ID.test(id) ? { kind: 'person', id } : undefined;
}

function encodeScreen(screen: ViewerScreen): string {
  if (screen.kind === 'note') return `n${screen.noteId}`;
  return screen.kind === 'journal' ? 'j' : 'h';
}

function decodeScreen(raw: string): ViewerScreen | undefined {
  if (raw === 'h') return { kind: 'home' };
  if (raw === 'j') return { kind: 'journal' };
  const id = raw.slice(1);
  return raw.startsWith('n') && COUNT.test(id) ? { kind: 'note', noteId: Number(id) } : undefined;
}

const encodeTime = (at: Date) => Math.floor(at.getTime() / 1000).toString(36);

function decodeTime(raw: string): number | undefined {
  return TIME.test(raw) ? Number.parseInt(raw, 36) : undefined;
}

function decodeCount(raw: string | undefined): number | undefined {
  return raw !== undefined && COUNT.test(raw) ? Number(raw) : undefined;
}

function customId(...parts: (string | number)[]): string {
  const id = [ID_PREFIX, ...parts].join(':');
  if (id.length > DISCORD_LIMITS.customId) throw new Error(`notes viewer: custom_id too long (${id.length})`);
  return id;
}

/** Whether a component or modal custom_id belongs to the notes viewer. */
export function isViewerCustomId(id: string): boolean {
  return id.startsWith(`${ID_PREFIX}:`);
}

/** Decodes a viewer custom_id; undefined for anything malformed (never trusted beyond its shape). */
export function parseViewerCustomId(id: string): ViewerAction | undefined {
  if (!isViewerCustomId(id) || id.length > DISCORD_LIMITS.customId) return undefined;
  const [, code, ...rest] = id.split(':');
  switch (code) {
    case 's': {
      const subject = decodeSubject(rest[0] ?? '');
      const issuedAt = decodeTime(rest[1] ?? '');
      return subject && issuedAt !== undefined && rest.length === 2
        ? { action: 'select', subject, issuedAt }
        : undefined;
    }
    case 'pp':
    case 'pn': {
      const subject = decodeSubject(rest[0] ?? '');
      const screen = decodeScreen(rest[1] ?? '');
      const page = decodeCount(rest[2]);
      const issuedAt = decodeTime(rest[3] ?? '');
      return subject && screen && page !== undefined && issuedAt !== undefined && rest.length === 4
        ? { action: 'page', subject, screen, page, issuedAt }
        : undefined;
    }
    case 'e':
    case 'm': {
      const subject = decodeSubject(rest[0] ?? '');
      const screen = decodeScreen(rest[1] ?? '');
      if (!subject || !screen) return undefined;
      if (code === 'm') return rest.length === 2 ? { action: 'modal', subject, screen } : undefined;
      const issuedAt = decodeTime(rest[2] ?? '');
      return issuedAt !== undefined && rest.length === 3 ? { action: 'edit', subject, screen, issuedAt } : undefined;
    }
    case 'u': {
      const subject = decodeSubject(rest[0] ?? '');
      const noteId = decodeCount(rest[1]);
      const version = decodeCount(rest[2]);
      const issuedAt = decodeTime(rest[3] ?? '');
      return subject && noteId !== undefined && version !== undefined && issuedAt !== undefined && rest.length === 4
        ? { action: 'undo', subject, noteId, version, issuedAt }
        : undefined;
    }
    case 'c':
    case 'x': {
      const token = rest[0] ?? '';
      const issuedAt = decodeTime(rest[1] ?? '');
      return TOKEN.test(token) && issuedAt !== undefined && rest.length === 2
        ? { action: code === 'c' ? 'confirm' : 'cancel', token, issuedAt }
        : undefined;
    }
    case 'qp':
    case 'qn': {
      const token = rest[0] ?? '';
      const page = decodeCount(rest[1]);
      const issuedAt = decodeTime(rest[2] ?? '');
      return TOKEN.test(token) && page !== undefined && issuedAt !== undefined && rest.length === 3
        ? { action: 'preview', token, page, issuedAt }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Whether a click on a component issued at `issuedAt` (epoch seconds) is past its 15 minutes (or from the future). */
export function isExpired(issuedAt: number, now: Date): boolean {
  const age = now.getTime() - issuedAt * 1000;
  return age > VIEWER_TTL_MS || age < -60_000;
}

/** The value a select option carries for a screen, and back. */
export function optionValue(screen: ViewerScreen): string {
  return encodeScreen(screen);
}

export function screenFromOption(value: string | undefined): ViewerScreen {
  return (value && decodeScreen(value)) || { kind: 'home' };
}

// ---- Rendering ----

export type ViewerPayload = {
  /** A notice above the note ('' for none: an update clears the previous one). */
  content: string;
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
};

export type ViewerContext = {
  memory: MemoryStore;
  notes: NotesStore;
  now: Date;
  /** The viewer is the bot's owner: Edit and Undo are offered. */
  owner: boolean;
  /** The person's display name (default: their current name in the identities table). */
  name?: string;
  /** A name for a person the identities table doesn't know. */
  fallbackName?: string;
  /** More names to find a person's name-only memories by (their live display name, handle). */
  lookupNames?: (string | undefined)[];
};

type ViewerOption = { screen: ViewerScreen; label: string; description: string };

/** The subject's display name. */
export function subjectName(subject: ViewerSubject, ctx: Pick<ViewerContext, 'memory' | 'name' | 'fallbackName'>) {
  if (subject.kind === 'group') return 'the group';
  return ctx.name ?? currentName(subject.id, ctx.fallbackName ?? 'them', ctx.memory);
}

function nameOf(memory: MemoryStore): (userId: string) => string | undefined {
  return (id) => currentName(id, '', memory) || undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function age(timestamp: string, now: Date): string {
  const relative = formatRelativeAge(timestamp, now);
  return relative ? `updated ${relative}` : 'updated';
}

function sameScreen(a: ViewerScreen, b: ViewerScreen): boolean {
  return encodeScreen(a) === encodeScreen(b);
}

/**
 * A note cut into pages of at most `max` characters, preferring to break before a heading, then at a
 * blank line, then at a line end, then at a space (always in the second half of the page), else hard.
 */
export function paginate(text: string, max = PAGE_CHARS): string[] {
  const pages: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    let cut = max;
    let separator = '';
    for (const candidate of ['\n#', '\n\n', '\n', ' ']) {
      const at = head.lastIndexOf(candidate);
      if (at > max / 2 && at <= max) {
        cut = at;
        separator = candidate;
        break;
      }
    }
    pages.push(rest.slice(0, cut).trimEnd());
    const next = rest.slice(cut);
    // Drop only the break itself: a nested list's indentation on the next page stays.
    rest = separator === ' ' ? next.replace(/^ +/, '') : separator ? next.replace(/^\n+/, '') : next;
  }
  if (rest.length > 0 || pages.length === 0) pages.push(rest);
  return pages;
}

/** Lines packed into pages of at most `max` characters (a line longer than a page is clipped). */
function packLines(lines: string[], max: number): string[] {
  const pages: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = clip(raw, max);
    if (current && current.length + 1 + line.length > max) {
      pages.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current || pages.length === 0) pages.push(current);
  return pages;
}

/** A raw memory as one line: `#12` content *(category, age)*. */
export function memoryLine(memory: Memory, now: Date): string {
  const content = clip(memory.content.replace(/\s+/g, ' '), MAX_MEMORY_CHARS);
  const when = formatRelativeAge(memory.updated_at, now);
  return `\`#${memory.id}\` ${escapeMarkdown(content)} *(${memory.category}${when ? `, ${when}` : ''})*`;
}

function personNotes(ctx: ViewerContext, id: string): Note[] {
  return ctx.notes.listNotes({ scope: 'person', ownerId: id });
}

function circleDescription(membership: CircleMembership | undefined, circle: Note, now: Date): string {
  const current = circle.members.filter((m) => m.until === null).length;
  const place = membership
    ? membership.membership.until === null
      ? `circle · ${current} members`
      : `former member${membershipSpan(membership.membership) ? ` (${membershipSpan(membership.membership)})` : ''}`
    : `circle · ${current} members`;
  return `${place} · ${age(circle.updatedAt, now)}`;
}

/**
 * The group's own (empty) screen while it has no notes but circles exist: without it the menu would only
 * lead to circles, and the owner's Edit there, which starts the group's notes, would be out of reach.
 */
const GROUP_HOME_OPTION: ViewerOption = {
  screen: { kind: 'home' },
  label: 'Group notes',
  description: 'none yet · the nightly dream writes them',
};

/**
 * The select menu's entries for a subject, at most 25: notes first (the group's empty screen while it has
 * none), then circles, then (a person) the journal.
 */
export function viewerOptions(subject: ViewerSubject, ctx: ViewerContext): ViewerOption[] {
  const noteOption = (note: Note): ViewerOption => ({
    screen: { kind: 'note', noteId: note.id },
    label: clip(note.title || note.topic, DISCORD_LIMITS.optionText),
    description: clip(
      `${note.topic} · ${formatNoteSize(note.content.length)} · ${age(note.updatedAt, ctx.now)}`,
      DISCORD_LIMITS.optionText,
    ),
  });
  const max = DISCORD_LIMITS.selectOptions;
  if (subject.kind === 'group') {
    const topics = ctx.notes.listNotes({ scope: 'group' }).map(noteOption);
    const allCircles = ctx.notes.listCircles();
    const home = topics.length === 0 && allCircles.length > 0 ? [GROUP_HOME_OPTION] : [];
    const circles = allCircles.slice(0, Math.max(0, max - topics.length - home.length)).map((circle) => ({
      ...noteOption(circle),
      description: clip(circleDescription(undefined, circle, ctx.now), DISCORD_LIMITS.optionText),
    }));
    return [...home, ...topics, ...circles];
  }
  const topics = personNotes(ctx, subject.id).map(noteOption);
  const circles = ctx.notes
    .circlesOf(subject.id, { includeFormer: true })
    .slice(0, Math.max(0, max - topics.length - 1))
    .map((membership) => ({
      ...noteOption(membership.circle),
      description: clip(circleDescription(membership, membership.circle, ctx.now), DISCORD_LIMITS.optionText),
    }));
  const journal: ViewerOption = {
    screen: { kind: 'journal' },
    label: 'Raw memories',
    description: 'what I picked up, newest first, with the ids forget_memory takes',
  };
  return [...topics, ...circles, journal];
}

/** What a screen resolves to: the note it shows, the journal, or nothing (an empty viewer). */
type Resolved =
  | { kind: 'note'; note: Note; notice?: string }
  | { kind: 'journal'; notice?: string }
  | { kind: 'empty'; notice?: string };

function resolveHome(subject: ViewerSubject, ctx: ViewerContext): Resolved {
  if (subject.kind === 'person') {
    // The profile first; no notes of their own yet → the raw memories (their circles stay in the menu).
    const profile = personNotes(ctx, subject.id).find((n) => n.topic === PROFILE_TOPIC);
    return profile ? { kind: 'note', note: profile } : { kind: 'journal' };
  }
  // The group: its first topic; none yet → its empty screen (never a circle: Edit there would edit the
  // circle, not start the group's notes). The circles stay in the menu.
  const first = ctx.notes.listNotes({ scope: 'group' })[0];
  return first ? { kind: 'note', note: first } : { kind: 'empty' };
}

function resolveScreen(state: ViewerState, ctx: ViewerContext): Resolved {
  const { screen, subject } = state;
  if (screen.kind === 'journal' && subject.kind === 'person') return { kind: 'journal' };
  if (screen.kind === 'note') {
    const note = ctx.notes.getNoteById(screen.noteId);
    if (note?.active) return { kind: 'note', note };
    return { ...resolveHome(subject, ctx), notice: VIEWER_LINES.noteGone };
  }
  return resolveHome(subject, ctx);
}

function footerFor(note: Note, page: number, pages: number, now: Date): string {
  const paging = pages > 1 ? ` · page ${page + 1}/${pages}` : '';
  return `v${note.version} · ${age(note.updatedAt, now)} by ${WRITERS[note.updatedBy] ?? note.updatedBy}${paging}`;
}

function field(name: string, value: string): APIEmbedField {
  return { name, value: clip(value || '—', DISCORD_LIMITS.fieldValue) };
}

/** The characters Discord counts toward an embed's 6,000 total. */
export function embedLength(embed: APIEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.author?.name.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

// What an embed may use of Discord's 6,000, with a margin.
const EMBED_BUDGET = DISCORD_LIMITS.embedTotal - 100;

/** Shortens an embed's fields (the longest first) until it fits Discord's total. */
function fitEmbed(embed: APIEmbed): APIEmbed {
  let over = embedLength(embed) - EMBED_BUDGET;
  if (over <= 0 || !embed.fields) return embed;
  const fields = embed.fields.map((f) => ({ ...f }));
  while (over > 0) {
    const longest = fields.reduce((a, b) => (b.value.length > a.value.length ? b : a));
    if (longest.value.length <= 20) break;
    const next = clip(longest.value, Math.max(20, longest.value.length - over - 1));
    over -= longest.value.length - next.length;
    longest.value = next;
  }
  return { ...embed, fields };
}

/** Page one of a profile: what the notes don't reflect yet (tonight's dream folds it in). */
function pendingField(note: Note, ctx: ViewerContext): APIEmbedField | undefined {
  if (note.scope !== 'person' || note.topic !== PROFILE_TOPIC || !note.ownerId) return undefined;
  const owner = { scope: 'person' as const, ownerId: note.ownerId };
  const newer = ctx.notes.newJournal(owner, { kinds: 'observations' }).length;
  const corrections = ctx.notes.openCorrections(owner, CORRECTIONS_SHOWN);
  if (newer === 0 && corrections.length === 0) return undefined;
  const lines: string[] = [];
  if (newer > 0) lines.push(`${newer} newer journal entr${newer === 1 ? 'y' : 'ies'} (the next dream folds them in)`);
  if (corrections.length > 0) {
    lines.push('Corrections (they win over the note):');
    lines.push(
      ...corrections.map((row) =>
        escapeMarkdown(correctionLine(row, nameOf(ctx.memory), ctx.now).replace(/^- /, '• ')),
      ),
    );
  }
  return field('Not in the notes yet', lines.join('\n'));
}

function circleFields(note: Note, ctx: ViewerContext): APIEmbedField[] {
  if (note.scope !== 'circle') return [];
  const fields = [field('Members', escapeMarkdown(describeMembers(note.members, nameOf(ctx.memory))))];
  if (note.aliases.length > 0) fields.push(field('Also called', escapeMarkdown(note.aliases.join(', '))));
  return fields;
}

function authorFor(note: Note, subject: ViewerSubject, name: string): string {
  if (note.scope === 'circle') return 'Circle';
  if (note.scope === 'group' || subject.kind === 'group') return "The group's notes";
  return clip(`Notes on ${name}`, DISCORD_LIMITS.embedTitle);
}

function button(
  id: string,
  label: string,
  style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger,
  disabled = false,
): APIButtonComponentWithCustomId {
  return { type: ComponentType.Button, custom_id: id, label, style, ...(disabled ? { disabled: true } : {}) };
}

function row(components: APIComponentInMessageActionRow[]): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components };
}

/**
 * The viewer for a state: the note (or journal page) as an embed, the select menu of the subject's notes
 * and circles, Prev/Next, and the owner's Edit/Undo. A subject with nothing to show and nothing to click
 * is a plain line. `notice` goes above the embed (a result, a warning).
 */
export function renderViewer(state: ViewerState, ctx: ViewerContext, notice?: string): ViewerPayload {
  const { subject } = state;
  const name = subjectName(subject, ctx);
  const issued = encodeTime(ctx.now);
  const options = viewerOptions(subject, ctx);
  const resolved = resolveScreen(state, ctx);
  const text = [notice, resolved.notice].filter((line): line is string => !!line).join('\n');

  let screen: ViewerScreen;
  let pages: string[];
  let embed: APIEmbed;
  let shownNote: Note | undefined;
  if (resolved.kind === 'note') {
    const note = resolved.note;
    shownNote = note;
    screen = { kind: 'note', noteId: note.id };
    pages = paginate(note.content);
    const page = Math.min(Math.max(0, state.page), pages.length - 1);
    const fields = page === 0 ? [pendingField(note, ctx), ...circleFields(note, ctx)] : [];
    embed = fitEmbed({
      author: { name: authorFor(note, subject, name) },
      title: clip(note.title || note.topic, DISCORD_LIMITS.embedTitle),
      description: pages[page] || '*(empty)*',
      ...(fields.some((f) => f) ? { fields: fields.filter((f): f is APIEmbedField => !!f) } : {}),
      footer: { text: footerFor(note, page, pages.length, ctx.now) },
    });
    state = { ...state, page };
  } else if (resolved.kind === 'journal' && subject.kind === 'person') {
    screen = { kind: 'journal' };
    const lookup = memoryKeyFor(ctx.memory, subject.id, ctx.lookupNames ?? []);
    const memories = ctx.memory
      .getForPerson(lookup, JOURNAL_FETCH_LIMIT)
      .filter((m) => !SELF_DIAGNOSIS.has(m.category));
    if (memories.length === 0 && options.length <= 1 && !ctx.owner) {
      return { content: [text, nothingKnownLine(name)].filter((l) => l).join('\n'), embeds: [], components: [] };
    }
    pages = packLines(
      memories.map((m) => memoryLine(m, ctx.now)),
      PAGE_CHARS,
    );
    const page = Math.min(Math.max(0, state.page), pages.length - 1);
    state = { ...state, page };
    const paging = pages.length > 1 ? ` · page ${page + 1}/${pages.length}` : '';
    embed = {
      author: { name: clip(`Notes on ${name}`, DISCORD_LIMITS.embedTitle) },
      title: 'Raw memories',
      description: memories.length > 0 ? pages[page] : nothingKnownLine(name),
      footer: {
        text:
          memories.length > 0
            ? `${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} · newest first${paging}`
            : 'no profile yet: the nightly dream writes one once there is something to go on',
      },
    };
  } else {
    if (options.length === 0 && !ctx.owner) {
      return { content: [text, VIEWER_LINES.noGroupNotes].filter((l) => l).join('\n'), embeds: [], components: [] };
    }
    screen = { kind: 'home' };
    pages = [''];
    embed = { author: { name: "The group's notes" }, description: VIEWER_LINES.noGroupNotes };
  }

  const components: ViewerPayload['components'] = [];
  if (options.length > 1) {
    const selectOptions: APISelectMenuOption[] = options.map((o) => ({
      label: o.label,
      value: optionValue(o.screen),
      description: o.description,
      ...(sameScreen(o.screen, screen) ? { default: true } : {}),
    }));
    components.push(
      row([
        {
          type: ComponentType.StringSelect,
          custom_id: customId('s', encodeSubject(subject), issued),
          placeholder: 'Pick a note',
          options: selectOptions,
        },
      ]),
    );
  }
  const buttons: APIButtonComponentWithCustomId[] = [];
  if (pages.length > 1) {
    const at = state.page;
    const target = encodeScreen(screen);
    buttons.push(
      button(
        customId('pp', encodeSubject(subject), target, Math.max(0, at - 1), issued),
        '◀ Prev',
        ButtonStyle.Secondary,
        at === 0,
      ),
      button(
        customId('pn', encodeSubject(subject), target, Math.min(pages.length - 1, at + 1), issued),
        'Next ▶',
        ButtonStyle.Secondary,
        at >= pages.length - 1,
      ),
    );
  }
  if (ctx.owner) {
    buttons.push(
      button(customId('e', encodeSubject(subject), encodeScreen(screen), issued), 'Edit', ButtonStyle.Primary),
    );
    if (shownNote && shownNote.version > 1) {
      buttons.push(
        button(
          customId('u', encodeSubject(subject), shownNote.id, shownNote.version, issued),
          `Undo v${shownNote.version}`,
          ButtonStyle.Danger,
        ),
      );
    }
  }
  if (buttons.length > 0) components.push(row(buttons));
  return { content: text, embeds: [embed], components };
}

// ---- The owner's edit ----

/** The modal behind Edit: "What should change?". Its custom_id carries the subject and the screen to return to. */
export function editModal(
  subject: ViewerSubject,
  screen: ViewerScreen,
  title: string,
): APIModalInteractionResponseCallbackData {
  return {
    custom_id: customId('m', encodeSubject(subject), encodeScreen(screen)),
    title: clip(title, DISCORD_LIMITS.modalTitle),
    components: [
      {
        type: ComponentType.Label,
        label: 'What should change?',
        description: 'Say it like you would to me. I draft it, you check the before/after, then confirm.',
        component: {
          type: ComponentType.TextInput,
          custom_id: INSTRUCTION_INPUT_ID,
          style: TextInputStyle.Paragraph,
          min_length: 1,
          max_length: MAX_INSTRUCTION_CHARS,
          required: true,
          placeholder: 'e.g. they moved to Laval in August 2026; the old apartment goes to Earlier',
        },
      },
    ],
  };
}

/** A drafted edit being previewed (held by notesViewerActions.ts until Confirm, Cancel or its 15 minutes). */
export type EditPreview = {
  token: string;
  changes: ProposedChange[];
  changeSummary: string;
  instruction: string;
  /** Epoch ms after which Confirm is refused. */
  expiresAt: number;
};

function membersText(members: CircleMember[] | undefined, memory: MemoryStore): string {
  return escapeMarkdown(describeMembers(members ?? [], nameOf(memory)) || 'nobody');
}

/**
 * The before/after preview of a drafted edit, one change per page: the diff of the note (removed lines
 * `-`, added `+`), a circle's membership and other names before and after, and Confirm/Cancel.
 */
export function renderPreview(
  preview: EditPreview,
  page: number,
  ctx: { memory: MemoryStore; now: Date },
): ViewerPayload {
  const count = preview.changes.length;
  const at = Math.min(Math.max(0, page), count - 1);
  const change = preview.changes[at];
  const issued = encodeTime(ctx.now);
  const expires = Math.floor(preview.expiresAt / 1000);
  const content = [
    `**Edit preview** · ${count} change${count === 1 ? '' : 's'}: ${escapeMarkdown(clip(preview.changeSummary || 'no summary', 300))}`,
    `-# you asked: ${escapeMarkdown(clip(preview.instruction.replace(/\s+/g, ' '), 300))}`,
    `-# nothing is saved until you confirm · this draft expires <t:${expires}:R>`,
  ].join('\n');

  const fields: APIEmbedField[] = [];
  if (change.kind === 'circle') {
    const membersBefore = JSON.stringify(change.membersBefore ?? []);
    const membersAfter = JSON.stringify(change.membersAfter ?? []);
    if (change.change !== 'removed' && membersBefore !== membersAfter) {
      if (change.change === 'changed')
        fields.push(field('Members before', membersText(change.membersBefore, ctx.memory)));
      fields.push(field('Members after', membersText(change.membersAfter, ctx.memory)));
    }
    const aliasesBefore = (change.aliasesBefore ?? []).join(', ');
    const aliasesAfter = (change.aliasesAfter ?? []).join(', ');
    if (change.change !== 'removed' && aliasesBefore !== aliasesAfter) {
      fields.push(field('Also called', escapeMarkdown(`${aliasesBefore || '—'} → ${aliasesAfter || '—'}`)));
    }
  }
  const what = change.kind === 'circle' ? `circle ${change.key}` : change.key;
  const frame: APIEmbed = {
    author: { name: `Change ${at + 1}/${count} · ${change.change}` },
    title: clip(`${change.title} (${what})`, DISCORD_LIMITS.embedTitle),
    ...(fields.length > 0 ? { fields } : {}),
    footer: { text: 'Confirm saves every change as a new version (Undo can take one back); Cancel drops the draft.' },
  };
  // The diff gets whatever the membership fields leave of the embed's total.
  const room = Math.min(PREVIEW_DIFF_CHARS, EMBED_BUDGET - embedLength(frame));
  const embed = fitEmbed({ ...frame, description: renderDiff(change.before, change.after, Math.max(400, room)) });

  const components: ViewerPayload['components'] = [];
  if (count > 1) {
    components.push(
      row([
        button(
          customId('qp', preview.token, Math.max(0, at - 1), issued),
          '◀ Previous change',
          ButtonStyle.Secondary,
          at === 0,
        ),
        button(
          customId('qn', preview.token, Math.min(count - 1, at + 1), issued),
          'Next change ▶',
          ButtonStyle.Secondary,
          at >= count - 1,
        ),
      ]),
    );
  }
  components.push(
    row([
      button(customId('c', preview.token, issued), 'Confirm', ButtonStyle.Success),
      button(customId('x', preview.token, issued), 'Cancel', ButtonStyle.Secondary),
    ]),
  );
  return { content, embeds: [embed], components };
}
