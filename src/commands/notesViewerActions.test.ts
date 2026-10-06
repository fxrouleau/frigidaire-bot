import {
  type APIActionRowComponent,
  type APIComponentInMessageActionRow,
  type APIEmbed,
  type APIModalInteractionResponseCallbackData,
  ComponentType,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../ai/memory/memoryStore';
import { type EditProposal, type EditTarget, proposeEdit } from '../ai/memory/notes/dreamer';
import { NotesStore } from '../ai/memory/notes/notesStore';
import type { NotesOutput } from '../ai/memory/notes/schema';
import { chatCompletionBody, createCapturingClient } from '../test-support/capturingClient';
import {
  createFakeButtonInteraction,
  createFakeCommandDeps,
  createFakeModalSubmitInteraction,
  createFakeSelectInteraction,
  type RecordedResponse,
} from '../test-support/fakeInteraction';
import { renderViewer, type ViewerState, VIEWER_TTL_MS } from './notesViewer';
import {
  EDIT_DRAFT_DEADLINE_MS,
  editFingerprint,
  editTargetFor,
  handleViewerInteraction,
  PendingEdits,
} from './notesViewerActions';
import { LINES } from './respond';

// Fictional cast, placeholder snowflakes.
const OWNER = '100000000000000050';
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const START = new Date('2026-09-25T16:00:00Z');

let memory: MemoryStore;
let notes: NotesStore;
let clock: Date;
let pendingEdits: PendingEdits;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  clock = START;
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => clock });
  pendingEdits = new PendingEdits();
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
  memory.upsertIdentity(OWNER, 'Ozzie');
  expect(
    notes.writeNotes(
      { scope: 'person', ownerId: REMI },
      [
        { topic: 'profile', title: 'Remi', content: '## Now\nRemi lives in Verdun.\n\n## Traits\nDeadpan.' },
        { topic: 'games', title: 'Games', content: '## Now\nValorant most nights.' },
      ],
      { updatedBy: 'dream' },
    ).ok,
  ).toBe(true);
  expect(
    notes.writeCircles(
      [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: '## Now\nFriday drafts at the game store.',
          aliases: [],
          members: [
            { id: REMI, since: '2021' },
            { id: NOVA, since: '2024' },
          ],
          merged_from: [],
        },
      ],
      { updatedBy: 'dream' },
    ).ok,
  ).toBe(true);
});

afterEach(() => {
  memory.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;
type Sent = { content?: string; embeds?: APIEmbed[]; components?: Row[] };

const REMI_HOME: ViewerState = { subject: { kind: 'person', id: REMI }, screen: { kind: 'home' }, page: 0 };

function fakeDeps(proposeEdit?: (target: EditTarget) => Promise<EditProposal>) {
  return createFakeCommandDeps({
    store: memory,
    notes,
    owners: [OWNER],
    now: () => clock,
    ...(proposeEdit ? { proposeEdit: (request) => proposeEdit(request.target) } : {}),
  });
}

/** The viewer as `viewer` would see it now (what the owner's or a member's message shows). */
function view(state: ViewerState = REMI_HOME, owner = true): Sent {
  return renderViewer(state, { memory, notes, now: clock, owner });
}

function componentId(sent: Sent, label: string): string {
  for (const row of sent.components ?? []) {
    for (const c of row.components) {
      if (c.type === ComponentType.Button && 'custom_id' in c && c.label === label) return c.custom_id;
      if (c.type === ComponentType.StringSelect && label === 'select') return c.custom_id;
    }
  }
  throw new Error(`no component "${label}" in ${JSON.stringify(sent.components)}`);
}

function labels(sent: Sent): string[] {
  return (sent.components ?? []).flatMap((row) =>
    row.components.map((c) => (c.type === ComponentType.Button && 'label' in c ? (c.label ?? '') : 'select')),
  );
}

function selected(sent: Sent): string | undefined {
  for (const row of sent.components ?? []) {
    for (const c of row.components) {
      if (c.type === ComponentType.StringSelect) return c.options.find((o) => o.default)?.label;
    }
  }
  return undefined;
}

type Fake = ReturnType<typeof fakeDeps>;

async function click(customId: string, fake: Fake, invokerId = OWNER): Promise<RecordedResponse[]> {
  const { interaction, responses } = createFakeButtonInteraction({ customId, invokerId, invokerUsername: 'clicker' });
  await handleViewerInteraction(interaction, fake.deps, { pendingEdits });
  return responses;
}

async function choose(customId: string, value: string, fake: Fake, invokerId = DALE): Promise<RecordedResponse[]> {
  const { interaction, responses } = createFakeSelectInteraction({ customId, values: [value], invokerId });
  await handleViewerInteraction(interaction, fake.deps, { pendingEdits });
  return responses;
}

async function submit(customId: string, instruction: string, fake: Fake, invokerId = OWNER) {
  const { interaction, responses } = createFakeModalSubmitInteraction({
    customId,
    fields: { instruction },
    invokerId,
    invokerUsername: 'clicker',
  });
  await handleViewerInteraction(interaction, fake.deps, { pendingEdits });
  return responses;
}

const sentOf = (response: RecordedResponse) => response.options as Sent;

function output(over: Partial<NotesOutput> = {}): NotesOutput {
  return {
    notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nRemi moved to Laval in August 2026.\n\n## Traits\nDeadpan.' }],
    removed_topics: [],
    circles: [],
    removed_circles: [],
    archived_circles: [],
    occasions: [],
    removed_occasions: [],
    change_summary: 'moved to Laval',
    ...over,
  };
}

const proposal = (target: EditTarget, out = output()): EditProposal => ({
  ok: true,
  target,
  output: out,
  allowedIds: [],
  changeSummary: out.change_summary,
});

/** Edit → modal → submit, returning the modal, the submit's responses and the preview. */
async function draft(fake: Fake, instruction = 'Remi moved to Laval in August', from: Sent = view()) {
  const opened = await click(componentId(from, 'Edit'), fake);
  expect(opened).toHaveLength(1);
  expect(opened[0].method).toBe('showModal');
  const modal = opened[0].options as APIModalInteractionResponseCallbackData;
  const responses = await submit(modal.custom_id, instruction, fake);
  return { modal, responses, preview: sentOf(responses[responses.length - 1]) };
}

describe('browsing', () => {
  it('switches to the picked topic in place, for anyone', async () => {
    const fake = fakeDeps();
    const responses = await choose(componentId(view(REMI_HOME, false), 'select'), `n${notes.getNote({ scope: 'person', ownerId: REMI }, 'games')?.id}`, fake);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ method: 'update', ephemeral: true, content: '' });
    const sent = sentOf(responses[0]);
    expect(sent.embeds?.[0].title).toBe('Games');
    expect(selected(sent)).toBe('Games');
    // Dale isn't the owner: the re-render has no Edit button either.
    expect(labels(sent)).toEqual(['select']);
  });

  it('opens a circle from the menu, with its members', async () => {
    const fake = fakeDeps();
    const responses = await choose(componentId(view(), 'select'), `n${notes.getCircle('mtg')?.id}`, fake);
    const embed = sentOf(responses[0]).embeds?.[0];
    expect(embed?.author?.name).toBe('Circle');
    expect(embed?.fields).toEqual([{ name: 'Members', value: 'Remi (since 2021), Nova (since 2024)' }]);
  });

  it('shows the raw memories from the menu', async () => {
    await memory.save({ category: 'fact', subject: 'Remi', content: 'Owns a canoe.', subject_user_id: REMI });
    const fake = fakeDeps();
    const responses = await choose(componentId(view(), 'select'), 'j', fake);
    expect(sentOf(responses[0]).embeds?.[0]).toMatchObject({ title: 'Raw memories' });
    expect(sentOf(responses[0]).embeds?.[0].description).toContain('Owns a canoe.');
  });

  it('pages through a long note with Prev/Next', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n${'Remi did a thing. '.repeat(12)}`).join('\n\n');
    notes.writeNotes({ scope: 'person', ownerId: REMI }, [{ topic: 'history', title: 'History', content: long }], {
      updatedBy: 'dream',
    });
    const history = notes.getNote({ scope: 'person', ownerId: REMI }, 'history');
    const first = view({ subject: { kind: 'person', id: REMI }, screen: { kind: 'note', noteId: history?.id ?? 0 }, page: 0 });
    expect(first.embeds?.[0].footer?.text).toBe('v1 · updated today by the nightly dream · page 1/2');
    expect(labels(first)).toEqual(['select', '◀ Prev', 'Next ▶', 'Edit']);

    const fake = fakeDeps();
    const second = sentOf((await click(componentId(first, 'Next ▶'), fake))[0]);
    expect(second.embeds?.[0].footer?.text).toBe('v1 · updated today by the nightly dream · page 2/2');
    expect(second.embeds?.[0].description?.startsWith('## Part')).toBe(true);
    const buttons = second.components?.[1].components ?? [];
    expect(buttons.map((b) => (b.type === ComponentType.Button ? b.disabled === true : undefined))).toEqual([
      false,
      true,
      false,
    ]);
    const back = sentOf((await click(componentId(second, '◀ Prev'), fake))[0]);
    expect(back.embeds?.[0].description).toBe(first.embeds?.[0].description);
  });

  it('refuses a click 15 minutes after the render, in character, and takes the buttons away', async () => {
    const fake = fakeDeps();
    const opened = view();
    clock = new Date(START.getTime() + VIEWER_TTL_MS + 60_000);
    const responses = await choose(componentId(opened, 'select'), 'j', fake);
    expect(responses).toEqual([
      expect.objectContaining({
        method: 'update',
        content: "this viewer's gone stale (they only last 15 minutes), right-click them again",
      }),
    ]);
    // The note stays readable: the update carries no embeds (Discord keeps the old ones).
    expect(sentOf(responses[0])).toEqual({
      content: "this viewer's gone stale (they only last 15 minutes), right-click them again",
      components: [],
      allowedMentions: { parse: [] },
    });
  });

  it('answers an unreadable custom_id privately instead of leaving the click hanging', async () => {
    const fake = fakeDeps();
    const responses = await click('nv:zz:nope', fake);
    expect(responses).toEqual([expect.objectContaining({ method: 'reply', ephemeral: true, content: LINES.unknownCommand })]);
    // A modal's id on a button is just as unreadable.
    const wrongKind = await click(`nv:m:p${REMI}:h`, fake);
    expect(wrongKind[0]).toMatchObject({ method: 'reply', ephemeral: true, content: LINES.unknownCommand });
  });

  it('is switched off with the commands (COMMANDS_ENABLED=false)', async () => {
    vi.stubEnv('COMMANDS_ENABLED', 'false');
    const fake = fakeDeps();
    const responses = await choose(componentId(view(), 'select'), 'j', fake);
    expect(responses).toEqual([expect.objectContaining({ method: 'reply', ephemeral: true, content: LINES.disabled })]);
  });
});

describe('owner edit', () => {
  it('drafts from the instruction, previews the before/after, and saves on Confirm', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { modal, responses, preview } = await draft(fake);

    expect(modal.title).toBe('Edit notes on Remi');
    expect(fake.recorders.proposeEdit.calls).toEqual([
      [
        {
          target: { scope: 'person', ownerId: REMI },
          instruction: 'Remi moved to Laval in August',
          requestedBy: OWNER,
          signal: expect.any(AbortSignal),
        },
      ],
    ]);
    // The deadline never fired: the draft answered in time.
    expect(fake.recorders.proposeEdit.calls[0][0].signal?.aborted).toBe(false);
    // Acknowledged at once (the draft takes a while), then the preview replaces the viewer.
    expect(responses.map((r) => r.method)).toEqual(['update', 'editReply']);
    expect(responses[0].content).toBe('✏️ drafting that edit… give me a minute');
    expect(sentOf(responses[0]).components).toEqual([]);
    expect(preview.content).toContain('**Edit preview** · 1 change: moved to Laval');
    expect(preview.embeds?.[0].description).toContain('- Remi lives in Verdun.');
    expect(preview.embeds?.[0].description).toContain('+ Remi moved to Laval in August 2026.');
    expect(labels(preview)).toEqual(['Confirm', 'Cancel']);
    // Nothing saved yet.
    expect(notes.getProfile(REMI)?.version).toBe(1);

    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({ method: 'update', content: 'done, saved profile v2' });
    const profile = notes.getProfile(REMI);
    expect(profile).toMatchObject({ version: 2, updatedBy: 'edit' });
    expect(profile?.content).toContain('Laval');
    expect(notes.getVersion(profile?.id ?? 0, 2)?.reason).toBe('Remi moved to Laval in August');
    const after = sentOf(confirmed[0]);
    expect(after.embeds?.[0].footer?.text).toBe('v2 · updated today by an owner edit');
    expect(labels(after)).toEqual(['select', 'Edit', 'Undo v2']);
    expect(pendingEdits.size).toBe(0);
    // The audit line for the report channel (sendToReportChannel sends it with parse: []).
    expect(fake.recorders.report.calls.map(([, text]) => text)).toEqual([
      `✏️ notes edit · Invoker edited Remi's notes: saved profile v2 · moved to Laval · asked: "Remi moved to Laval in August"`,
    ]);
  });

  it('keeps the audit line to one capped line, posts none for a cancelled draft, and survives a failed post', async () => {
    const long = 'Remi moved to Laval\n\nin August. '.repeat(40);
    const fake = createFakeCommandDeps({
      store: memory,
      notes,
      owners: [OWNER],
      now: () => clock,
      proposeEdit: async (request) => proposal(request.target),
      report: async () => {
        throw new Error('Missing Access');
      },
    });
    const cancelled = await draft(fake);
    await click(componentId(cancelled.preview, 'Cancel'), fake);
    expect(fake.recorders.report.calls).toHaveLength(0);

    const { preview } = await draft(fake, long);
    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0]).toMatchObject({ method: 'update', content: 'done, saved profile v2' });
    const [[, text]] = fake.recorders.report.calls;
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain('asked: "Remi moved to Laval in August. Remi moved');
  });

  it('edits the circle on screen as that circle', async () => {
    const circle = notes.getCircle('mtg');
    const out = output({
      notes: [],
      circles: [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: '## Now\nFriday drafts, now at Nova’s place.',
          aliases: ['magic crew'],
          members: [
            { id: REMI, since: '2021' },
            { id: NOVA, since: '2024' },
          ],
          merged_from: [],
        },
      ],
      change_summary: 'drafts moved to Nova’s',
    });
    const fake = fakeDeps(async (target) => proposal(target, out));
    const from = view({ subject: { kind: 'person', id: REMI }, screen: { kind: 'note', noteId: circle?.id ?? 0 }, page: 0 });
    const { modal, preview } = await draft(fake, 'drafts happen at Nova’s now', from);
    expect(modal.title).toBe('Edit circle: The MTG crew');
    expect(fake.recorders.proposeEdit.calls[0][0].target).toEqual({ scope: 'circle', slug: 'mtg' });
    expect(preview.embeds?.[0].title).toBe('The MTG crew (circle mtg)');

    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0].content).toBe('done, saved circle mtg v2');
    expect(notes.getCircle('mtg')).toMatchObject({ version: 2, updatedBy: 'edit', aliases: ['magic crew'] });
    expect(sentOf(confirmed[0]).embeds?.[0].author?.name).toBe('Circle');
  });

  it('pages through a draft with several changes', async () => {
    const out = output({
      notes: [
        { topic: 'profile', title: 'Remi', content: '## Now\nRemi moved to Laval.' },
        { topic: 'games', title: 'Games', content: '## Now\nQuit Valorant.' },
      ],
    });
    const fake = fakeDeps(async (target) => proposal(target, out));
    const { preview } = await draft(fake);
    expect(labels(preview)).toEqual(['◀ Previous change', 'Next change ▶', 'Confirm', 'Cancel']);
    const next = sentOf((await click(componentId(preview, 'Next change ▶'), fake))[0]);
    expect(next.embeds?.[0].author?.name).toBe('Change 2/2 · changed');
    expect(next.embeds?.[0].description).toContain('+ Quit Valorant.');
  });

  it('drops the draft on Cancel', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { preview } = await draft(fake);
    const cancelled = await click(componentId(preview, 'Cancel'), fake);
    expect(cancelled[0]).toMatchObject({ method: 'update', content: 'dropped it, nothing changed' });
    expect(sentOf(cancelled[0]).embeds?.[0].title).toBe('Remi');
    expect(notes.getProfile(REMI)?.version).toBe(1);
    // The draft is gone: a late Confirm saves nothing.
    const late = await click(componentId(preview, 'Confirm'), fake);
    expect(late[0].content).toBe(
      'that draft went stale (I only hold them for 15 minutes, and not across restarts). hit Edit again',
    );
    expect(notes.getProfile(REMI)?.version).toBe(1);
  });

  it('saves a draft only once, however many times Confirm is clicked', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { preview } = await draft(fake);
    await click(componentId(preview, 'Confirm'), fake);
    const again = await click(componentId(preview, 'Confirm'), fake);
    expect(again[0].content).toMatch(/^that draft went stale/);
    expect(notes.getProfile(REMI)?.version).toBe(2);
  });

  it('refuses to save over notes that changed since the draft (the dream got there first)', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { preview } = await draft(fake);
    notes.writeNotes(
      { scope: 'person', ownerId: REMI },
      [{ topic: 'profile', title: 'Remi', content: '## Now\nRemi adopted a cat.' }],
      { updatedBy: 'dream' },
    );
    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0].content).toBe(
      'those notes changed since I drafted that, so I saved nothing. hit Edit again for a fresh draft',
    );
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'dream' });
  });

  it('lets a draft go stale after 15 minutes', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { preview } = await draft(fake);
    clock = new Date(START.getTime() + VIEWER_TTL_MS + 1000);
    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0].content).toMatch(/^that draft went stale/);
    expect(notes.getProfile(REMI)?.version).toBe(1);
  });

  it('says so in character when the draft fails, and puts the viewer back', async () => {
    const fake = fakeDeps(async () => {
      throw new Error('upstream 503');
    });
    const { responses } = await draft(fake);
    const last = responses[responses.length - 1];
    expect(last).toMatchObject({ method: 'editReply', content: "couldn't draft that edit, my pen broke. try again in a bit" });
    expect(labels(sentOf(last))).toEqual(['select', 'Edit']);
  });

  it("shows why the edit model's draft was refused", async () => {
    const fake = fakeDeps(async () => ({ ok: false, error: 'profile over 4000 characters' }));
    const { responses } = await draft(fake);
    expect(responses[responses.length - 1].content).toBe(
      "couldn't turn that into a clean edit (profile over 4000 characters). try wording it differently",
    );
  });

  it('says so when the draft changes nothing', async () => {
    const same = output({
      notes: [{ topic: 'profile', title: 'Remi', content: notes.getProfile(REMI)?.content ?? '' }],
      change_summary: '',
    });
    const fake = fakeDeps(async (target) => proposal(target, same));
    const { responses } = await draft(fake);
    expect(responses[responses.length - 1].content).toBe("that draft didn't change anything");
    expect(pendingEdits.size).toBe(0);
  });

  it("passes on the edit model's reason when it changed nothing (the edit prompt asks for one)", async () => {
    const why = output({ notes: [], change_summary: 'Remi has no *Valorant* paragraph to drop' });
    const fake = fakeDeps(async (target) => proposal(target, why));
    const { responses } = await draft(fake, 'drop the Valorant paragraph');
    expect(responses[responses.length - 1].content).toBe(
      "that draft didn't change anything: Remi has no \\*Valorant\\* paragraph to drop",
    );
    expect(pendingEdits.size).toBe(0);
  });

  it("stops a draft that would outlive Discord's 15 minutes, aborts its model call and says so while it can", async () => {
    const fake = fakeDeps();
    // The edit model never answers; like the real proposeEdit, the draft ends when its signal aborts.
    fake.deps.proposeEdit = (request) =>
      new Promise<EditProposal>((resolve) => {
        request.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'the draft was stopped' }), {
          once: true,
        });
      });
    const opened = await click(componentId(view(), 'Edit'), fake);
    const modal = opened[0].options as APIModalInteractionResponseCallbackData;
    const { interaction, responses } = createFakeModalSubmitInteraction({
      customId: modal.custom_id,
      fields: { instruction: 'rewrite everything about Remi' },
      invokerId: OWNER,
    });
    await handleViewerInteraction(interaction, fake.deps, { pendingEdits, editDeadlineMs: 5 });
    expect(responses.map((r) => r.method)).toEqual(['update', 'editReply']);
    expect(responses[1].content).toBe(
      'that draft was taking forever (Discord only waits 15 minutes on me), so I dropped it. try a smaller ask',
    );
    expect(labels(sentOf(responses[1]))).toEqual(['select', 'Edit']);
    expect(pendingEdits.size).toBe(0);
    expect(notes.getProfile(REMI)?.version).toBe(1);
  });

  it('gives a draft 12 minutes by default, inside the 15 Discord allows', async () => {
    expect(EDIT_DRAFT_DEADLINE_MS).toBe(12 * 60_000);
    const fake = fakeDeps();
    let signal: AbortSignal | undefined;
    fake.deps.proposeEdit = (request) => {
      signal = request.signal;
      return new Promise<EditProposal>(() => {});
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { interaction, responses } = createFakeModalSubmitInteraction({
        customId: `nv:m:p${REMI}:h`,
        fields: { instruction: 'Remi moved to Laval' },
        invokerId: OWNER,
      });
      const done = handleViewerInteraction(interaction, fake.deps, { pendingEdits });
      await vi.advanceTimersByTimeAsync(EDIT_DRAFT_DEADLINE_MS - 1);
      expect(responses.map((r) => r.method)).toEqual(['update']);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(signal?.aborted).toBe(true);
      expect(responses.map((r) => r.method)).toEqual(['update', 'editReply']);
      expect(responses[1].content).toMatch(/^that draft was taking forever/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a draft that came back for someone other than who was asked about', async () => {
    const fake = fakeDeps(async () => proposal({ scope: 'person', ownerId: DALE }));
    const { responses } = await draft(fake);
    expect(responses[responses.length - 1].content).toBe("couldn't draft that edit, my pen broke. try again in a bit");
    expect(pendingEdits.size).toBe(0);
  });

  it('drafts nothing when the note Edit was opened on is gone by the time the modal comes back', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const games = notes.getNote({ scope: 'person', ownerId: REMI }, 'games');
    const from = view({ subject: { kind: 'person', id: REMI }, screen: { kind: 'note', noteId: games?.id ?? 0 }, page: 0 });
    const opened = await click(componentId(from, 'Edit'), fake);
    const modal = opened[0].options as APIModalInteractionResponseCallbackData;
    notes.writeNotes({ scope: 'person', ownerId: REMI }, [], { updatedBy: 'dream', removeTopics: ['games'] });
    const responses = await submit(modal.custom_id, 'Remi plays Deadlock now', fake);
    expect(responses).toEqual([
      expect.objectContaining({
        method: 'reply',
        ephemeral: true,
        content: "that note's gone (removed or merged), here's what's left",
      }),
    ]);
    expect(fake.recorders.proposeEdit.calls).toHaveLength(0);
  });

  it('asks for an instruction when the modal comes back blank', async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const responses = await submit(`nv:m:p${REMI}:h`, '   ', fake);
    expect(responses).toEqual([
      expect.objectContaining({ method: 'reply', ephemeral: true, content: 'you have to tell me what to change' }),
    ]);
    expect(fake.recorders.proposeEdit.calls).toHaveLength(0);
  });
});

describe('owner edit through the real proposeEdit (dreamer.ts)', () => {
  const REMI_ALT = '100000000000000011';
  /** The viewer's deps with the dream part's own proposeEdit, over a capturing client scripted with `answers`. */
  function realDeps(...answers: unknown[]) {
    const { client, requests } = createCapturingClient(
      answers.map((answer) => ({ body: chatCompletionBody(JSON.stringify(answer)) })),
    );
    const fake = createFakeCommandDeps({
      store: memory,
      notes,
      owners: [OWNER],
      now: () => clock,
      proposeEdit: (request) => proposeEdit(request, { notes, memory, client, now: () => clock }),
    });
    return { fake, requests };
  }

  it("round-trips a person's edit: the draft comes back for exactly that person and saves on Confirm", async () => {
    const { fake, requests } = realDeps({
      notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nRemi moved to Laval in August 2026.\n\n## Traits\nDeadpan.' }],
      change_summary: 'moved to Laval',
    });
    const { preview } = await draft(fake);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('X-Frigidaire-Feature')).toBe('memory_edit');
    expect(requests[0].body.provider).toEqual({ zdr: true });
    expect(preview.content).toContain('**Edit preview** · 1 change: moved to Laval');

    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0].content).toBe('done, saved profile v2');
    expect(notes.getProfile(REMI)).toMatchObject({ version: 2, updatedBy: 'edit' });
  });

  it("drafts a side account's notes as its main account's (the viewer's target is canonical too)", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    const { fake } = realDeps({
      notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nRemi lives in Laval.' }],
      change_summary: 'Laval',
    });
    const responses = await submit(`nv:m:p${REMI_ALT}:h`, 'Remi lives in Laval', fake);
    expect(fake.recorders.proposeEdit.calls[0][0].target).toEqual({ scope: 'person', ownerId: REMI });
    const preview = sentOf(responses[responses.length - 1]);
    expect(labels(preview)).toEqual(['Confirm', 'Cancel']);
    await click(componentId(preview, 'Confirm'), fake);
    expect(notes.getProfile(REMI)?.content).toBe('## Now\nRemi lives in Laval.');
  });

  it('round-trips a circle edit (its slug) and a group edit', async () => {
    const circle = notes.getCircle('mtg');
    const { fake, requests } = realDeps(
      {
        notes: [],
        circles: [
          {
            slug: 'mtg',
            title: 'The MTG crew',
            content: '## Now\nFriday drafts at Nova’s place.',
            aliases: [],
            members: [
              { id: REMI, since: '2021' },
              { id: NOVA, since: '2024' },
            ],
            merged_from: [],
          },
        ],
        change_summary: 'drafts moved',
      },
      { notes: [{ topic: 'vibe', title: 'Vibe', content: '## Now\nRoasts are affection.' }], change_summary: 'vibe' },
    );
    const onCircle = view({ subject: { kind: 'person', id: REMI }, screen: { kind: 'note', noteId: circle?.id ?? 0 }, page: 0 });
    const circleDraft = await draft(fake, 'drafts are at Nova’s now', onCircle);
    expect(fake.recorders.proposeEdit.calls[0][0].target).toEqual({ scope: 'circle', slug: 'mtg' });
    expect((await click(componentId(circleDraft.preview, 'Confirm'), fake))[0].content).toBe('done, saved circle mtg v2');

    notes.writeNotes({ scope: 'group' }, [{ topic: 'vibe', title: 'Vibe', content: '## Now\nChaotic.' }], {
      updatedBy: 'dream',
    });
    const groupHome = view({ subject: { kind: 'group' }, screen: { kind: 'home' }, page: 0 });
    const groupDraft = await draft(fake, 'add that roasts are affection', groupHome);
    expect(fake.recorders.proposeEdit.calls[1][0].target).toEqual({ scope: 'group' });
    expect((await click(componentId(groupDraft.preview, 'Confirm'), fake))[0].content).toBe('done, saved vibe v2');
    expect(notes.getNote({ scope: 'group' }, 'vibe')).toMatchObject({ updatedBy: 'edit' });
    expect(requests.map((r) => r.headers.get('X-Frigidaire-Feature'))).toEqual(['memory_edit', 'memory_edit']);
  });
});

describe('the group before its first notes (circles already exist)', () => {
  const GROUP_HOME: ViewerState = { subject: { kind: 'group' }, screen: { kind: 'home' }, page: 0 };

  function menu(sent: Sent): string[] {
    for (const row of sent.components ?? []) {
      for (const c of row.components) if (c.type === ComponentType.StringSelect) return c.options.map((o) => o.label);
    }
    return [];
  }

  it('opens on the empty group notes, with the circles one pick away, for anyone', () => {
    const sent = view(GROUP_HOME, false);
    expect(sent.embeds?.[0]).toMatchObject({
      author: { name: "The group's notes" },
      description: 'no group notes yet, the nightly dream writes them',
    });
    expect(menu(sent)).toEqual(['Group notes', 'The MTG crew']);
    expect(selected(sent)).toBe('Group notes');
    expect(labels(sent)).toEqual(['select']);
  });

  it("lets the owner start the group's notes with Edit, even after opening a circle", async () => {
    const lore = output({
      notes: [{ topic: 'lore', title: 'Lore', content: '## Now\nThe server started as a study group.' }],
      change_summary: 'first lore',
    });
    const fake = fakeDeps(async (target) => proposal(target, lore));
    const home = view(GROUP_HOME);
    const onCircle = sentOf((await choose(componentId(home, 'select'), `n${notes.getCircle('mtg')?.id}`, fake, OWNER))[0]);
    expect(onCircle.embeds?.[0].author?.name).toBe('Circle');
    const back = sentOf((await choose(componentId(onCircle, 'select'), 'h', fake, OWNER))[0]);
    expect(back.embeds?.[0].description).toBe('no group notes yet, the nightly dream writes them');

    const { modal, preview } = await draft(fake, 'start the lore: we began as a study group', back);
    expect(modal.title).toBe("Edit the group's notes");
    expect(fake.recorders.proposeEdit.calls[0][0].target).toEqual({ scope: 'group' });
    const confirmed = await click(componentId(preview, 'Confirm'), fake);
    expect(confirmed[0].content).toBe('done, saved lore v1');
    expect(notes.getNote({ scope: 'group' }, 'lore')).toMatchObject({ version: 1, updatedBy: 'edit' });
    expect(notes.getCircle('mtg')?.version).toBe(1);
    // With a group note, the placeholder entry is gone.
    expect(menu(sentOf(confirmed[0]))).toEqual(['Lore', 'The MTG crew']);
  });
});

describe('owner-only', () => {
  it('never offers Edit or Undo to anyone else, and refuses them when clicked anyway', async () => {
    notes.writeNotes({ scope: 'person', ownerId: REMI }, [{ topic: 'profile', title: 'Remi', content: '## Now\nv2.' }], {
      updatedBy: 'dream',
    });
    expect(labels(view(REMI_HOME, false))).toEqual(['select']);
    const ownerView = view();
    const fake = fakeDeps(async (target) => proposal(target));

    for (const label of ['Edit', 'Undo v2']) {
      const responses = await click(componentId(ownerView, label), fake, DALE);
      expect(responses).toEqual([
        expect.objectContaining({ method: 'reply', ephemeral: true, content: 'hands off, only the boss edits my notes' }),
      ]);
    }
    const submitted = await submit(`nv:m:p${REMI}:h`, 'make Remi the villain', fake, DALE);
    expect(submitted[0]).toMatchObject({ method: 'reply', content: 'hands off, only the boss edits my notes' });
    expect(fake.recorders.proposeEdit.calls).toHaveLength(0);
    expect(notes.getProfile(REMI)?.version).toBe(2);
  });

  it("says to try again (and does nothing) when the owner check doesn't answer in time", async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    fake.deps.isOwner = () => new Promise<boolean>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = click(componentId(view(), 'Edit'), fake);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toEqual([
        expect.objectContaining({
          method: 'reply',
          ephemeral: true,
          content: "couldn't check who's asking just now, try that again in a sec",
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a non-owner's Confirm even with the draft's token", async () => {
    const fake = fakeDeps(async (target) => proposal(target));
    const { preview } = await draft(fake);
    const responses = await click(componentId(preview, 'Confirm'), fake, DALE);
    expect(responses[0]).toMatchObject({ method: 'reply', content: 'hands off, only the boss edits my notes' });
    expect(notes.getProfile(REMI)?.version).toBe(1);
    // The owner's own Confirm still works.
    await click(componentId(preview, 'Confirm'), fake);
    expect(notes.getProfile(REMI)?.version).toBe(2);
  });
});

describe('undo', () => {
  beforeEach(() => {
    notes.writeNotes(
      { scope: 'person', ownerId: REMI },
      [{ topic: 'profile', title: 'Remi', content: '## Now\nRemi is the villain now.' }],
      { updatedBy: 'edit', reason: 'a bad edit' },
    );
  });

  it('puts the shown note back to its previous version, as a new version', async () => {
    const fake = fakeDeps();
    const responses = await click(componentId(view(), 'Undo v2'), fake);
    expect(responses[0]).toMatchObject({
      method: 'update',
      content: `undone: "Remi" is back to v1's text (saved as v3)`,
    });
    const profile = notes.getProfile(REMI);
    expect(profile).toMatchObject({ version: 3, updatedBy: 'undo' });
    expect(profile?.content).toContain('Verdun');
    expect(sentOf(responses[0]).embeds?.[0].footer?.text).toBe('v3 · updated today by an undo');
    expect(fake.recorders.report.calls.map(([, text]) => text)).toEqual([
      `↩️ notes undo · Invoker undid v2 of Remi's "profile" note: back to v1's text (saved as v3)`,
    ]);
  });

  it('undoes a circle merge whole: the merged-away circle comes back and the notice and audit say so', async () => {
    const circle = (slug: string, title: string, content: string, mergedFrom: string[] = []) => ({
      slug,
      title,
      content,
      aliases: [],
      members: [
        { id: REMI, since: '2021' },
        { id: NOVA, since: '2024' },
      ],
      merged_from: mergedFrom,
    });
    notes.writeCircles([circle('magic', 'Magic nights', '## Now\nThursday casual games.')], { updatedBy: 'dream' });
    notes.writeCircles([circle('mtg', 'The MTG crew', '## Now\nDrafts and casual games.', ['magic'])], {
      updatedBy: 'dream',
    });
    const mtgId = notes.getCircle('mtg')?.id ?? 0;
    const state: ViewerState = { ...REMI_HOME, screen: { kind: 'note', noteId: mtgId } };
    const fake = fakeDeps();

    const responses = await click(componentId(view(state), 'Undo v2'), fake);
    expect(responses[0].content).toBe(
      `undone: "The MTG crew" is back to v1's text (saved as v3); "Magic nights" is back`,
    );
    expect(notes.getCircle('magic')?.content).toBe('## Now\nThursday casual games.');
    expect(fake.recorders.report.calls.map(([, text]) => text)).toEqual([
      `↩️ notes undo · Invoker undid v2 of circle "The MTG crew": back to v1's text (saved as v3); "Magic nights" is back`,
    ]);
  });

  it('offers Undo on a circle a merge created, which removes it and brings back what it merged', async () => {
    const merged = {
      slug: 'card-crew',
      title: 'The card crew',
      content: '## Now\nCards.',
      aliases: [],
      members: [{ id: REMI }, { id: NOVA }],
      merged_from: ['mtg'],
    };
    expect(notes.writeCircles([merged], { updatedBy: 'dream' }).ok).toBe(true);
    const crewId = notes.getCircle('card-crew')?.id ?? 0;
    const state: ViewerState = { ...REMI_HOME, screen: { kind: 'note', noteId: crewId } };
    const fake = fakeDeps();

    const responses = await click(componentId(view(state), 'Undo v1'), fake);
    expect(responses[0].content).toBe(`undone: "The card crew" is removed (saved as v2); "The MTG crew" is back`);
    expect(notes.getCircle('card-crew')).toBeUndefined();
    expect(notes.getCircle('mtg')?.content).toBe('## Now\nFriday drafts at the game store.');
  });

  it('never undoes twice from one button (a double click)', async () => {
    const fake = fakeDeps();
    const button = componentId(view(), 'Undo v2');
    await click(button, fake);
    const again = await click(button, fake);
    expect(again[0].content).toBe("that note changed since you opened it, so I didn't undo anything. here's the latest");
    expect(notes.getProfile(REMI)?.version).toBe(3);
    expect(fake.recorders.report.calls).toHaveLength(1);
  });
});

describe('PendingEdits', () => {
  const entry = (createdAt: number) => ({
    proposal: proposal({ scope: 'person', ownerId: REMI }) as Extract<EditProposal, { ok: true }>,
    changes: [],
    changeSummary: '',
    instruction: 'x',
    requestedBy: OWNER,
    createdAt,
    subject: { kind: 'person' as const, id: REMI },
    returnTo: { kind: 'home' as const },
    fingerprint: '',
  });

  it('holds a draft for its time, then forgets it', () => {
    const edits = new PendingEdits(1000);
    const held = edits.add(entry(0));
    expect(held.token).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(edits.get(held.token, 999)).toBe(held);
    expect(edits.get(held.token, 1001)).toBeUndefined();
    expect(edits.size).toBe(0);
  });

  it('keeps at most a few drafts, dropping the oldest', () => {
    const edits = new PendingEdits(60_000, 2);
    const first = edits.add(entry(0));
    edits.add(entry(1));
    edits.add(entry(2));
    expect(edits.size).toBe(2);
    expect(edits.get(first.token, 3)).toBeUndefined();
  });
});

describe('editFingerprint', () => {
  it('moves when any note the draft covers gets a new version', () => {
    const target = { scope: 'person', ownerId: REMI } as const;
    const out = output({
      circles: [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: '## Now\nx',
          aliases: [],
          members: [{ id: REMI }, { id: NOVA }],
          merged_from: [],
        },
      ],
    });
    const before = editFingerprint(notes, target, out);
    expect(before).toMatch(/^profile@\d+\.1,games@\d+\.1,circle:mtg@\d+\.1$/);
    notes.writeCircles(
      [{ slug: 'mtg', title: 'The MTG crew', content: '## Now\ny', aliases: [], members: [{ id: REMI }, { id: NOVA }], merged_from: [] }],
      { updatedBy: 'dream' },
    );
    expect(editFingerprint(notes, target, out)).not.toBe(before);
  });

  it("covers an occasion edit's own occasion and the circles an answer archives", () => {
    notes.writeOccasions(
      [
        {
          slug: 'ski-trip-2027',
          title: 'Ski trip',
          content: '## Plan\nx',
          starts_on: '2027-01-10',
          participants: [{ id: REMI }, { id: NOVA }],
        },
      ],
      { updatedBy: 'dream' },
    );
    const occasion = notes.getOccasion('ski-trip-2027');
    const screen = { kind: 'note' as const, noteId: occasion?.id ?? 0 };
    expect(editTargetFor({ kind: 'person', id: REMI }, screen, notes)).toEqual({ scope: 'occasion', slug: 'ski-trip-2027' });
    const target = { scope: 'occasion', slug: 'ski-trip-2027' } as const;
    const before = editFingerprint(notes, target, output({ notes: [] }));
    expect(before).toMatch(/^occasion:ski-trip-2027@\d+\.1$/);
    expect(editFingerprint(notes, { scope: 'group' }, output({ notes: [], archived_circles: ['mtg'] }))).toContain(
      'circle:mtg@',
    );
  });
});
