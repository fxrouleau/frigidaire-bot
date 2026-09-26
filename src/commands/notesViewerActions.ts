// What happens when someone clicks in the notes viewer (notesViewer.ts): the select menu and Prev/Next
// re-render the viewer in place (interaction.update); the owner's Edit opens a modal, whose submit has the
// edit model draft the change (dreamer.ts proposeEdit) and shows a before/after preview with Confirm and
// Cancel; Confirm saves it (applyEdit: new versions, updated_by 'edit', the instruction as the reason);
// Undo puts the shown note back to its previous version.
//
// Safety:
// - Owner-only actions (Edit, the modal, Undo, Confirm) re-check the owner on every click (src/botOwner.ts:
//   BOT_OWNER_USER_IDS, else the application's owner; fails closed). A viewer message is ephemeral, but a
//   button is never trusted to prove who may press it.
// - A viewer's buttons expire 15 minutes after the render that issued them (custom_id carries the time);
//   a drafted edit is held in memory for 15 minutes (not across restarts) and is refused on Confirm when
//   the notes it would overwrite changed meanwhile (the nightly dream, another edit, an undo).
// - Undo carries the version it was shown for, so a double click never undoes twice.
// - Every failure is an in-character private line; nothing escapes as an unhandled rejection.
import { randomBytes } from 'node:crypto';
import {
  type ButtonInteraction,
  escapeMarkdown,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { applyEdit, type EditProposal, type EditTarget, previewChanges } from '../ai/memory/notes/dreamer';
import type { Note, NotesStore } from '../ai/memory/notes/notesStore';
import type { NotesOutput } from '../ai/memory/notes/schema';
import { config } from '../config';
import { canonicalUserId } from '../linkedAccounts';
import { logger } from '../logger';
import { defaultCommandDeps } from './index';
import {
  type EditPreview,
  editModal,
  INSTRUCTION_INPUT_ID,
  isExpired,
  MAX_INSTRUCTION_CHARS,
  ownerWithin,
  parseViewerCustomId,
  renderPreview,
  renderViewer,
  screenFromOption,
  subjectName,
  VIEWER_LINES,
  VIEWER_TTL_MS,
  type ViewerContext,
  type ViewerPayload,
  type ViewerScreen,
  type ViewerState,
  type ViewerSubject,
} from './notesViewer';
import { LINES } from './respond';
import type { CommandDeps } from './types';

export { isViewerCustomId } from './notesViewer';

export type ViewerInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/** A drafted edit waiting for Confirm or Cancel. */
export type PendingEdit = EditPreview & {
  proposal: Extract<EditProposal, { ok: true }>;
  /** The owner who asked (main id). */
  requestedBy: string;
  createdAt: number;
  subject: ViewerSubject;
  /** Where the viewer goes back to after Cancel (and after Confirm when nothing shown was written). */
  returnTo: ViewerScreen;
  /** The versions the draft was made against (see editFingerprint). */
  fingerprint: string;
};

/** Drafted edits by token, for VIEWER_TTL_MS each, at most `max` at once (the oldest go first). In memory only. */
export class PendingEdits {
  private readonly entries = new Map<string, PendingEdit>();

  constructor(
    private readonly ttlMs = VIEWER_TTL_MS,
    private readonly max = 20,
  ) {}

  add(entry: Omit<PendingEdit, 'token' | 'expiresAt'>): PendingEdit {
    this.prune(entry.createdAt);
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const token = randomBytes(9).toString('base64url');
    const pending: PendingEdit = { ...entry, token, expiresAt: entry.createdAt + this.ttlMs };
    this.entries.set(token, pending);
    return pending;
  }

  /** The pending edit, unless it is unknown or past its time (then it is forgotten). */
  get(token: string, now: number): PendingEdit | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (now > entry.expiresAt) {
      this.entries.delete(token);
      return undefined;
    }
    return entry;
  }

  delete(token: string): void {
    this.entries.delete(token);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [token, entry] of this.entries) if (now > entry.expiresAt) this.entries.delete(token);
  }
}

const sharedPendingEdits = new PendingEdits();

export type ViewerActionOptions = { pendingEdits?: PendingEdits };

/**
 * The versions an edit is drafted against: the target's notes (a person's or the group's topics, or the one
 * circle) and every circle the output touches, as `key@id.version` (or `-` for none). Confirm refuses when
 * it changed, so a draft never silently overwrites what the dream (or another edit) wrote meanwhile.
 */
export function editFingerprint(notes: NotesStore, target: EditTarget, output: NotesOutput): string {
  const parts: string[] = [];
  if (target.scope !== 'circle') {
    for (const note of notes.listNotes(target)) parts.push(`${note.topic}@${note.id}.${note.version}`);
  }
  const slugs = new Set<string>([
    ...output.circles.flatMap((c) => [c.slug, ...c.merged_from]),
    ...output.removed_circles,
    ...(target.scope === 'circle' ? [target.slug] : []),
  ]);
  for (const slug of [...slugs].sort()) {
    const circle = notes.getCircle(slug);
    parts.push(`circle:${slug}@${circle ? `${circle.id}.${circle.version}` : '-'}`);
  }
  return parts.join(',');
}

/** What an Edit on a screen changes: the circle it shows, else the subject (a person or the group). */
export function editTargetFor(subject: ViewerSubject, screen: ViewerScreen, notes: NotesStore): EditTarget {
  if (screen.kind === 'note') {
    const note = notes.getNoteById(screen.noteId);
    if (note?.active && note.scope === 'circle') return { scope: 'circle', slug: note.topic };
  }
  // The main account, as proposeEdit() answers for (a draft for another target is dropped).
  return subject.kind === 'group' ? { scope: 'group' } : { scope: 'person', ownerId: canonicalUserId(subject.id) };
}

function describeTarget(target: EditTarget): string {
  if (target.scope === 'circle') return `circle ${target.slug}`;
  return target.scope === 'group' ? 'the group' : `person ${target.ownerId}`;
}

/** The longest audit line posted to the report channel, and the longest instruction or summary in it. */
const AUDIT_MAX_CHARS = 600;
const AUDIT_TEXT_CHARS = 200;
/** The longest model text quoted in a notice above the viewer. */
const NOTICE_TEXT_CHARS = 300;

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Posts the audit line of an owner edit or undo to the report channel (sendToReportChannel: `parse: []`),
 * after the viewer was redrawn. Never throws; a line that did not go out is only logged (the INFO log line
 * already has it).
 */
async function postAudit(interaction: ViewerInteraction, deps: CommandDeps, line: string): Promise<void> {
  try {
    const text = oneLine(line, AUDIT_MAX_CHARS);
    if (!(await deps.report(interaction.client, text))) {
      logger.info(`notes viewer: no report-channel audit line (none set, or the send failed): ${text}`);
    }
  } catch (error) {
    logger.warn('notes viewer: posting the audit line failed:', error);
  }
}

/** Whose notes a target is, in words: "Remi's notes", "the group's notes", "circle The MTG crew". */
function targetLabel(target: EditTarget, notes: NotesStore, views: Views): string {
  if (target.scope === 'circle') return `circle "${notes.getCircle(target.slug)?.title ?? target.slug}"`;
  if (target.scope === 'group') return "the group's notes";
  return `${views.name({ kind: 'person', id: target.ownerId })}'s notes`;
}

/** Who pressed the button, by the name the server shows. */
function clickerName(interaction: ViewerInteraction): string {
  const member = interaction.member as { displayName?: string } | null;
  return member?.displayName ?? interaction.user.displayName ?? interaction.user.username;
}

function update(payload: ViewerPayload): InteractionUpdateOptions {
  return {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    allowedMentions: { parse: [] },
  };
}

function privately(content: string): InteractionReplyOptions {
  return { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

/** An in-character line to the clicker, in whatever state the interaction is in. Never throws. */
async function tellPrivately(interaction: ViewerInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(privately(content));
    else await interaction.reply(privately(content));
  } catch (error) {
    logger.warn(`notes viewer: could not tell ${interaction.user.username} "${content}":`, error);
  }
}

/** The clicked message gone stale: say so and take its components away (the note stays readable). */
async function markExpired(interaction: ButtonInteraction | StringSelectMenuInteraction, line: string) {
  await interaction.update({ content: line, components: [], allowedMentions: { parse: [] } });
}

/** Handles a click (or a modal submit) in the notes viewer. Never throws. */
export async function handleViewerInteraction(
  interaction: ViewerInteraction,
  deps: CommandDeps = defaultCommandDeps(),
  opts: ViewerActionOptions = {},
): Promise<void> {
  try {
    await dispatch(interaction, deps, opts.pendingEdits ?? sharedPendingEdits);
  } catch (error) {
    logger.warn(`notes viewer: ${interaction.customId} failed:`, error);
    await tellPrivately(interaction, LINES.failed);
  }
}

async function dispatch(interaction: ViewerInteraction, deps: CommandDeps, pending: PendingEdits): Promise<void> {
  if (!config.commands.enabled) {
    await tellPrivately(interaction, LINES.disabled);
    return;
  }
  const action = parseViewerCustomId(interaction.customId);
  if (!action) {
    logger.warn(`notes viewer: unreadable custom_id ${JSON.stringify(interaction.customId.slice(0, 100))}`);
    await tellPrivately(interaction, LINES.unknownCommand);
    return;
  }
  const now = deps.now();
  const views = new Views(interaction, deps);

  if ((action.action === 'modal') !== interaction.isModalSubmit()) {
    logger.warn(`notes viewer: custom_id ${interaction.customId} arrived on the wrong kind of interaction`);
    await tellPrivately(interaction, LINES.unknownCommand);
    return;
  }
  if (action.action === 'modal') {
    if (interaction.isModalSubmit()) await submitEdit(interaction, action.subject, action.screen, views, pending);
    return;
  }
  if (interaction.isModalSubmit()) return;
  // A draft's buttons (Confirm, Cancel, its paging) live as long as the draft itself (PendingEdits).
  if ('issuedAt' in action && !('token' in action) && isExpired(action.issuedAt, now)) {
    await markExpired(interaction, VIEWER_LINES.expired);
    return;
  }

  switch (action.action) {
    case 'select': {
      const value = interaction.isStringSelectMenu() ? interaction.values[0] : undefined;
      const state = { subject: action.subject, screen: screenFromOption(value), page: 0 };
      await interaction.update(update(await views.render(state)));
      return;
    }
    case 'page':
      await interaction.update(
        update(await views.render({ subject: action.subject, screen: action.screen, page: action.page })),
      );
      return;
    case 'edit':
      await openEditModal(interaction, action.subject, action.screen, views);
      return;
    case 'undo':
      await undoNote(interaction, action.subject, action.noteId, action.version, views);
      return;
    case 'preview': {
      const edit = pending.get(action.token, now.getTime());
      if (!edit) {
        await markExpired(interaction, VIEWER_LINES.draftExpired);
        return;
      }
      await interaction.update(update(renderPreview(edit, action.page, { memory: deps.memoryStore(), now })));
      return;
    }
    case 'confirm':
      await confirmEdit(interaction, action.token, views, pending);
      return;
    case 'cancel': {
      const edit = pending.get(action.token, now.getTime());
      pending.delete(action.token);
      if (!edit) {
        await markExpired(interaction, VIEWER_LINES.draftExpired);
        return;
      }
      logger.info(
        `notes viewer: ${interaction.user.username} cancelled an edit of ${describeTarget(edit.proposal.target)}`,
      );
      await interaction.update(
        update(await views.render({ subject: edit.subject, screen: edit.returnTo, page: 0 }, VIEWER_LINES.cancelled)),
      );
      return;
    }
  }
}

/** Renders viewer states for one interaction (the clicker's owner status looked up once). */
class Views {
  private owner: Promise<boolean | undefined> | undefined;

  constructor(
    readonly interaction: ViewerInteraction,
    readonly deps: CommandDeps,
  ) {}

  /** Whether the clicker is the owner; undefined when the check didn't answer in time (ownerWithin). */
  isOwner(): Promise<boolean | undefined> {
    this.owner ??= ownerWithin(this.deps.isOwner(this.interaction.client, this.interaction.user.id));
    return this.owner;
  }

  /** A name for a person the identities table doesn't know: Discord's cached user, if any. */
  private fallbackName(subject: ViewerSubject): string | undefined {
    if (subject.kind !== 'person') return undefined;
    return this.interaction.client.users?.cache?.get(subject.id)?.displayName;
  }

  async render(state: ViewerState, notice?: string): Promise<ViewerPayload> {
    const ctx: ViewerContext = {
      memory: this.deps.memoryStore(),
      notes: this.deps.notesStore(),
      now: this.deps.now(),
      owner: (await this.isOwner()) === true,
      fallbackName: this.fallbackName(state.subject),
    };
    return renderViewer(state, ctx, notice);
  }

  name(subject: ViewerSubject): string {
    return subjectName(subject, { memory: this.deps.memoryStore(), fallbackName: this.fallbackName(subject) });
  }
}

async function refuseNonOwner(interaction: ViewerInteraction, views: Views, what: string): Promise<boolean> {
  const owner = await views.isOwner();
  if (owner === true) return false;
  if (owner === undefined) {
    logger.warn(`notes viewer: the owner check for ${interaction.user.username} timed out, refused ${what} for now`);
    await tellPrivately(interaction, VIEWER_LINES.ownerUnknown);
    return true;
  }
  logger.info(`notes viewer: ${interaction.user.username} is not the owner, refused ${what}`);
  await tellPrivately(interaction, VIEWER_LINES.ownerOnly);
  return true;
}

async function openEditModal(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  subject: ViewerSubject,
  screen: ViewerScreen,
  views: Views,
): Promise<void> {
  if (await refuseNonOwner(interaction, views, 'Edit')) return;
  const notes = views.deps.notesStore();
  const target = editTargetFor(subject, screen, notes);
  const title =
    target.scope === 'circle'
      ? `Edit circle: ${notes.getCircle(target.slug)?.title ?? target.slug}`
      : target.scope === 'group'
        ? "Edit the group's notes"
        : `Edit notes on ${views.name(subject)}`;
  await interaction.showModal(editModal(subject, screen, title));
}

async function submitEdit(
  interaction: ModalSubmitInteraction,
  subject: ViewerSubject,
  screen: ViewerScreen,
  views: Views,
  pending: PendingEdits,
): Promise<void> {
  if (await refuseNonOwner(interaction, views, 'an edit')) return;
  const instruction = interaction.fields.getTextInputValue(INSTRUCTION_INPUT_ID).trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) {
    await tellPrivately(interaction, VIEWER_LINES.emptyInstruction);
    return;
  }
  const deps = views.deps;
  const notes = deps.notesStore();
  if (screen.kind === 'note' && !notes.getNoteById(screen.noteId)?.active) {
    // The note Edit was opened on is gone (removed, merged): the instruction was about it, so draft nothing.
    await tellPrivately(interaction, VIEWER_LINES.noteGone);
    return;
  }
  const target = editTargetFor(subject, screen, notes);
  const requestedBy = canonicalUserId(interaction.user.id);
  const back = { subject, screen, page: 0 };

  // Acknowledge within Discord's 3 seconds; the draft takes a while (a strong model).
  if (interaction.isFromMessage()) {
    await interaction.update({ content: VIEWER_LINES.drafting, components: [], allowedMentions: { parse: [] } });
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
  logger.info(`notes viewer: ${interaction.user.username} asked for an edit of ${describeTarget(target)}`);

  let proposal: EditProposal;
  try {
    proposal = await deps.proposeEdit({ target, instruction, requestedBy });
  } catch (error) {
    logger.warn(`notes viewer: drafting an edit of ${describeTarget(target)} failed:`, error);
    await interaction.editReply(update(await views.render(back, VIEWER_LINES.draftFailed)));
    return;
  }
  if (!proposal.ok) {
    logger.info(`notes viewer: the edit model's draft for ${describeTarget(target)} was refused: ${proposal.error}`);
    const why = proposal.error.replace(/\s+/g, ' ').slice(0, 300);
    await interaction.editReply(
      update(await views.render(back, `couldn't turn that into a clean edit (${why}). try wording it differently`)),
    );
    return;
  }
  if (describeTarget(proposal.target) !== describeTarget(target)) {
    // Never save a draft for anyone but who the owner asked about.
    logger.warn(
      `notes viewer: a draft for ${describeTarget(target)} came back for ${describeTarget(proposal.target)}, dropped`,
    );
    await interaction.editReply(update(await views.render(back, VIEWER_LINES.draftFailed)));
    return;
  }

  const changes = previewChanges(notes, proposal.target, proposal.output);
  if (changes.length === 0) {
    // The edit prompt has the model say why when it can't apply an instruction: pass that on (the model's
    // own words only: proposal.changeSummary falls back to the instruction itself).
    const why = oneLine(proposal.output.change_summary, NOTICE_TEXT_CHARS);
    logger.info(`notes viewer: the draft for ${describeTarget(target)} changed nothing${why ? `: ${why}` : ''}`);
    const notice = why ? `${VIEWER_LINES.noChange}: ${escapeMarkdown(why)}` : VIEWER_LINES.noChange;
    await interaction.editReply(update(await views.render(back, notice)));
    return;
  }
  const now = deps.now();
  const edit = pending.add({
    proposal,
    changes,
    changeSummary: proposal.changeSummary,
    instruction,
    requestedBy,
    createdAt: now.getTime(),
    subject,
    returnTo: screen,
    fingerprint: editFingerprint(notes, proposal.target, proposal.output),
  });
  await interaction.editReply(update(renderPreview(edit, 0, { memory: deps.memoryStore(), now })));
}

async function confirmEdit(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  token: string,
  views: Views,
  pending: PendingEdits,
): Promise<void> {
  if (await refuseNonOwner(interaction, views, 'Confirm')) return;
  const deps = views.deps;
  const edit = pending.get(token, deps.now().getTime());
  if (!edit) {
    await markExpired(interaction, VIEWER_LINES.draftExpired);
    return;
  }
  // One Confirm per draft, whatever happens next.
  pending.delete(token);
  const notes = deps.notesStore();
  const target = edit.proposal.target;
  if (editFingerprint(notes, target, edit.proposal.output) !== edit.fingerprint) {
    logger.info(`notes viewer: an edit of ${describeTarget(target)} was refused, the notes changed since the draft`);
    await interaction.update(
      update(await views.render({ subject: edit.subject, screen: edit.returnTo, page: 0 }, VIEWER_LINES.changedSince)),
    );
    return;
  }

  const result = applyEdit(edit.proposal, edit.instruction, notes);
  if (!result.ok) {
    logger.warn(`notes viewer: saving an edit of ${describeTarget(target)} failed: ${result.errors.join('; ')}`);
    const why = result.errors.join('; ').replace(/\s+/g, ' ').slice(0, 300);
    await interaction.update(
      update(
        await views.render({ subject: edit.subject, screen: edit.returnTo, page: 0 }, `couldn't save that (${why})`),
      ),
    );
    return;
  }

  const describe = (note: Note) => `${note.scope === 'circle' ? `circle ${note.topic}` : note.topic} v${note.version}`;
  const saved = result.written.map(describe);
  const removed = result.removed.map((n) => (n.scope === 'circle' ? `circle ${n.topic}` : n.topic));
  logger.info(
    `notes viewer: ${interaction.user.username} saved an edit of ${describeTarget(target)} (${[...saved, ...removed.map((r) => `-${r}`)].join(', ') || 'nothing new'}): ${edit.changeSummary}`,
  );
  const summary = [
    saved.length > 0 ? `saved ${saved.join(', ')}` : '',
    removed.length > 0 ? `removed ${removed.join(', ')}` : '',
  ]
    .filter((part) => part)
    .join('; ');
  const shown = result.written.find((n) => n.active);
  const screen: ViewerScreen = shown ? { kind: 'note', noteId: shown.id } : edit.returnTo;
  await interaction.update(
    update(
      await views.render({ subject: edit.subject, screen, page: 0 }, `done, ${summary || 'nothing needed saving'}`),
    ),
  );
  if (saved.length > 0 || removed.length > 0) {
    await postAudit(
      interaction,
      deps,
      `✏️ notes edit · ${clickerName(interaction)} edited ${targetLabel(target, notes, views)}: ${summary} · ${oneLine(edit.changeSummary, AUDIT_TEXT_CHARS)} · asked: "${oneLine(edit.instruction, AUDIT_TEXT_CHARS)}"`,
    );
  }
}

async function undoNote(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  subject: ViewerSubject,
  noteId: number,
  version: number,
  views: Views,
): Promise<void> {
  if (await refuseNonOwner(interaction, views, 'Undo')) return;
  const deps = views.deps;
  const notes = deps.notesStore();
  const note = notes.getNoteById(noteId);
  const here = { subject, screen: { kind: 'note' as const, noteId }, page: 0 };
  if (!note?.active || note.version !== version) {
    await interaction.update(update(await views.render(here, VIEWER_LINES.undoStale)));
    return;
  }
  const result = notes.undo(noteId);
  if (!result.ok) {
    logger.info(`notes viewer: undo of note #${noteId} v${version} refused: ${result.error}`);
    await interaction.update(update(await views.render(here, `couldn't undo that: ${result.error}`)));
    return;
  }
  const restored = result.note;
  logger.info(
    `notes viewer: ${interaction.user.username} undid note #${noteId} (${restored.scope} ${restored.topic}) v${version} → v${restored.version}`,
  );
  const notice = restored.active
    ? `undone: "${restored.title}" is back to v${version - 1}'s text (saved as v${restored.version})`
    : `undone: "${restored.title}" is removed again, as it was in v${version - 1} (saved as v${restored.version})`;
  const screen: ViewerScreen = restored.active ? { kind: 'note', noteId } : { kind: 'home' };
  await interaction.update(update(await views.render({ subject, screen, page: 0 }, notice)));
  const what =
    restored.scope === 'circle'
      ? `circle "${restored.title}"`
      : `${subject.kind === 'group' ? "the group's" : `${views.name(subject)}'s`} "${restored.topic}" note`;
  await postAudit(
    interaction,
    deps,
    `↩️ notes undo · ${clickerName(interaction)} undid v${version} of ${what}: ${restored.active ? `back to v${version - 1}'s text` : `removed again, as in v${version - 1}`} (saved as v${restored.version})`,
  );
}
