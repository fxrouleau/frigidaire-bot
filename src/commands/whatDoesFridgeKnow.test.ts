import { type APIActionRowComponent, type APIComponentInMessageActionRow, type APIEmbed, ComponentType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORRECTION_CATEGORY, MemoryStore } from '../ai/memory/memoryStore';
import { NotesStore } from '../ai/memory/notes/notesStore';
import { createFakeCommandDeps, createFakeUserCommandInteraction } from '../test-support/fakeInteraction';
import { handleContextMenuCommand } from './index';
import { PAGE_CHARS, parseViewerCustomId } from './notesViewer';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const REMI_ALT = '100000000000000011';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const BOT = '100000000000000099';
const COMMAND = 'What does Fridge know?';

let memory: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  memory = new MemoryStore(':memory:');
  // Notes written two days before the fake "now".
  notes = new NotesStore(memory, { now: () => new Date('2026-09-23T12:00:00Z') });
  memory.upsertIdentity(REMI, 'Remi', 'remi_r');
  memory.upsertIdentity(DALE, 'Dale', 'dale_d');
  memory.upsertIdentity(NOVA, 'Nova', 'nova_n');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Row = APIActionRowComponent<APIComponentInMessageActionRow>;
type Sent = { content?: string; embeds?: APIEmbed[]; components?: Row[]; flags?: number; allowedMentions?: unknown };

async function open(
  target: { id: string; username?: string; memberDisplayName?: string | null },
  opts: { owners?: string[]; invokerId?: string; now?: Date } = {},
) {
  const { interaction, responses } = createFakeUserCommandInteraction(
    { username: 'someone', ...target },
    { commandName: COMMAND, botUserId: BOT, invokerId: opts.invokerId ?? DALE },
  );
  const fake = createFakeCommandDeps({ store: memory, notes, owners: opts.owners, now: opts.now });
  await handleContextMenuCommand(interaction, fake.deps);
  expect(responses).toHaveLength(1);
  return { response: responses[0], sent: responses[0].options as Sent, recorders: fake.recorders };
}

function selectOf(sent: Sent) {
  for (const row of sent.components ?? []) {
    for (const component of row.components) {
      if (component.type === ComponentType.StringSelect) return component;
    }
  }
  return undefined;
}

function buttonsOf(sent: Sent): { label: string; id: string; disabled: boolean }[] {
  const buttons: { label: string; id: string; disabled: boolean }[] = [];
  for (const row of sent.components ?? []) {
    for (const component of row.components) {
      if (component.type === ComponentType.Button && 'custom_id' in component) {
        buttons.push({ label: component.label ?? '', id: component.custom_id, disabled: component.disabled === true });
      }
    }
  }
  return buttons;
}

const profile = (content = '## Now\nRemi runs the Friday game nights.\n\n## Traits\nDeadpan.') => ({
  topic: 'profile',
  title: 'Remi',
  content,
});

describe('What does Fridge know? (no notes yet: the raw memories)', () => {
  it("lists memories matched by id or any of the person's names, privately, without self-diagnosis rows", async () => {
    memory.updateIdentityMeta(REMI, { aliases_add: ['Rem'] });
    await memory.save({ category: 'fact', subject: 'Remi', content: 'Still plays on PS4.', subject_user_id: REMI });
    await memory.save({ category: 'preference', subject: 'Rem', content: 'Hates cilantro.' });
    await memory.save({ category: 'fact', subject: 'Dale', content: 'Drives a Civic.', subject_user_id: DALE });
    await memory.save({ category: 'capability_gap', subject: 'Remi', content: 'Bot cannot read PDFs.', subject_user_id: REMI });

    // Real clock: the rows were just saved with SQLite's datetime('now').
    const { response, sent } = await open({ id: REMI, username: 'remi_r', memberDisplayName: 'Remi' }, { now: new Date() });

    expect(response).toMatchObject({ method: 'reply', ephemeral: true });
    expect(sent.allowedMentions).toEqual({ parse: [] });
    const embed = sent.embeds?.[0];
    expect(embed?.author?.name).toBe('Notes on Remi');
    expect(embed?.title).toBe('Raw memories');
    expect(embed?.description).toMatch(/`#\d+` Still plays on PS4\. \*\(fact, today\)\*/);
    expect(embed?.description).toContain('Hates cilantro.');
    expect(embed?.description).not.toContain('Civic');
    expect(embed?.description).not.toContain('PDFs');
    expect(embed?.footer?.text).toBe('2 memories · newest first');
    // Nothing else to pick and not the owner: no components at all.
    expect(sent.components).toEqual([]);
  });

  it('also finds rows filed under the IRL name or the Discord handle', async () => {
    memory.updateIdentityMeta(REMI, { irl_name: 'Remi M' });
    await memory.save({ category: 'fact', subject: 'Remi M', content: 'Grew up in Laval.' });
    await memory.save({ category: 'preference', subject: 'lapinlune', content: 'Mains Thresh.' });

    const { sent } = await open({ id: REMI, username: 'lapinlune', memberDisplayName: 'Remi' }, { now: new Date() });

    expect(sent.embeds?.[0].description).toContain('Grew up in Laval.');
    expect(sent.embeds?.[0].description).toContain('Mains Thresh.');
  });

  it("shows a linked side account's member: the main account's name and memories (LINKED_ACCOUNTS)", async () => {
    vi.stubEnv('LINKED_ACCOUNTS', `${REMI_ALT}:${REMI}`);
    memory.upsertIdentity(REMI_ALT, 'Remmy', 'remi_alt');
    await memory.save({ category: 'fact', subject: 'Remi', content: 'Owns a canoe.', subject_user_id: REMI });
    await memory.save({ category: 'fact', subject: 'Remmy', content: 'Lives in Laval.' });

    const { sent } = await open({ id: REMI_ALT, username: 'remi_alt', memberDisplayName: 'Remmy' }, { now: new Date() });

    expect(sent.embeds?.[0].author?.name).toBe('Notes on Remi');
    expect(sent.embeds?.[0].description).toContain('Owns a canoe.');
    expect(sent.embeds?.[0].description).toContain('Lives in Laval.');
  });

  it('says so in one plain line when it knows nothing', async () => {
    const { response, sent } = await open({ id: '100000000000000009', username: 'newguy', memberDisplayName: null });
    expect(response).toMatchObject({ method: 'reply', ephemeral: true, content: "I've got nothing on newguy yet" });
    expect(sent.embeds).toEqual([]);
    expect(sent.components).toEqual([]);
  });

  it('pages through a long memory list', async () => {
    for (let i = 0; i < 60; i++) {
      // Distinct words per row, or save() would merge them as duplicates.
      const words = Array.from({ length: 24 }, (_, k) => `w${i}x${k}`).join(' ');
      await memory.save({ category: 'fact', subject: 'Remi', content: `${words}.`, subject_user_id: REMI });
    }
    const { sent } = await open({ id: REMI, memberDisplayName: 'Remi' }, { now: new Date() });
    const embed = sent.embeds?.[0];
    expect(embed?.description?.length).toBeLessThanOrEqual(PAGE_CHARS);
    expect(embed?.footer?.text).toMatch(/^60 memories · newest first · page 1\/\d+$/);
    expect(buttonsOf(sent).map((b) => [b.label, b.disabled])).toEqual([
      ['◀ Prev', true],
      ['Next ▶', false],
    ]);
  });

  it('reports a broken memory store in character', async () => {
    const { interaction, responses } = createFakeUserCommandInteraction(
      { id: REMI, memberDisplayName: 'Remi' },
      { commandName: COMMAND, botUserId: BOT },
    );
    memory.close();
    await handleContextMenuCommand(interaction, createFakeCommandDeps({ store: memory, notes }).deps);
    expect(responses[0]).toMatchObject({
      method: 'reply',
      ephemeral: true,
      content: 'ugh, that one broke on my end. try again in a bit',
    });
  });
});

describe('What does Fridge know? (notes)', () => {
  beforeEach(() => {
    expect(
      notes.writeNotes(
        { scope: 'person', ownerId: REMI },
        [profile(), { topic: 'games', title: 'Games', content: '## Now\nValorant most nights.' }],
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
            aliases: ['magic crew'],
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

  it('shows the profile first, a menu of topics, circles and raw memories, and a footer', async () => {
    const { sent, recorders } = await open({ id: REMI, memberDisplayName: 'Remi' });
    const embed = sent.embeds?.[0];
    expect(embed?.author?.name).toBe('Notes on Remi');
    expect(embed?.title).toBe('Remi');
    expect(embed?.description).toContain('Remi runs the Friday game nights.');
    expect(embed?.footer?.text).toBe('v1 · updated 2d ago by the nightly dream');

    const select = selectOf(sent);
    expect(select?.options.map((o) => [o.label, o.default === true])).toEqual([
      ['Remi', true],
      ['Games', false],
      ['The MTG crew', false],
      ['Raw memories', false],
    ]);
    expect(select?.options[2].description).toBe('circle · 2 members · updated 2d ago');
    expect(select?.custom_id.length).toBeLessThanOrEqual(100);

    // Not the owner: no Edit, no Undo.
    expect(buttonsOf(sent)).toEqual([]);
    expect(recorders.isOwner.calls.map((c) => c[1])).toEqual([DALE]);
  });

  it('gives the owner Edit, and Undo once the note has an earlier version', async () => {
    let { sent } = await open({ id: REMI, memberDisplayName: 'Remi' }, { owners: [DALE] });
    expect(buttonsOf(sent).map((b) => b.label)).toEqual(['Edit']);

    notes.writeNotes({ scope: 'person', ownerId: REMI }, [profile('## Now\nRemi moved to Laval.')], {
      updatedBy: 'edit',
    });
    ({ sent } = await open({ id: REMI, memberDisplayName: 'Remi' }, { owners: [DALE] }));
    expect(buttonsOf(sent).map((b) => b.label)).toEqual(['Edit', 'Undo v2']);
    expect(sent.embeds?.[0].footer?.text).toBe('v2 · updated 2d ago by an owner edit');
    const undo = parseViewerCustomId(buttonsOf(sent)[1].id);
    expect(undo).toMatchObject({ action: 'undo', noteId: notes.getProfile(REMI)?.id, version: 2 });
  });

  it("shows the notes without owner buttons when the owner check doesn't answer in time", async () => {
    const { interaction, responses } = createFakeUserCommandInteraction(
      { id: REMI, memberDisplayName: 'Remi' },
      { commandName: COMMAND, botUserId: BOT, invokerId: DALE },
    );
    const fake = createFakeCommandDeps({ store: memory, notes, owners: [DALE] });
    fake.deps.isOwner = () => new Promise<boolean>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = handleContextMenuCommand(interaction, fake.deps);
      await vi.advanceTimersByTimeAsync(1_500);
      await done;
    } finally {
      vi.useRealTimers();
    }
    const sent = responses[0].options as Sent;
    expect(sent.embeds?.[0].title).toBe('Remi');
    expect(buttonsOf(sent)).toEqual([]);
  });

  it("lists what the notes don't reflect yet on the profile: newer journal rows and open corrections", async () => {
    const seq = notes.journalHighWater();
    notes.recordDreamSuccess({ scope: 'person', ownerId: REMI }, seq);
    await memory.save({ category: 'fact', subject: 'Remi', content: 'Adopted a cat named Pixel.', subject_user_id: REMI });
    await memory.save({
      category: CORRECTION_CATEGORY,
      subject: 'Remi',
      content: 'Quit Valorant in August.',
      subject_user_id: REMI,
      said_by: REMI,
    });

    const { sent } = await open({ id: REMI, memberDisplayName: 'Remi' }, { now: new Date() });
    const pending = sent.embeds?.[0].fields?.find((f) => f.name === 'Not in the notes yet');
    expect(pending?.value).toContain('1 newer journal entry');
    expect(pending?.value).toContain('Remi, about themself: Quit Valorant in August.');
  });

  it('describes each menu entry with its size and age (the profile is one page: no paging buttons)', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `## Part ${i}\n${'Remi did a thing. '.repeat(12)}`).join('\n\n');
    expect(
      notes.writeNotes({ scope: 'person', ownerId: REMI }, [{ topic: 'history', title: 'History', content: long }], {
        updatedBy: 'dream',
      }).ok,
    ).toBe(true);
    const { sent } = await open({ id: REMI, memberDisplayName: 'Remi' });
    const history = selectOf(sent)?.options.find((o) => o.label === 'History');
    expect(history?.description).toMatch(/^history · \d\.\dk chars · updated 2d ago$/);
    expect(buttonsOf(sent)).toEqual([]);
  });

  it('shows the group notes (and every circle) when the bot itself is right-clicked', async () => {
    notes.writeNotes(
      { scope: 'group' },
      [
        { topic: 'lore', title: 'Lore', content: '## Now\nThe server started as a study group.' },
        { topic: 'vibe', title: 'Vibe', content: '## Now\nDry jokes, loud game nights.' },
      ],
      { updatedBy: 'bootstrap' },
    );
    const { sent } = await open({ id: BOT, username: 'frigidaire', memberDisplayName: 'Frigidaire' });
    const embed = sent.embeds?.[0];
    expect(embed?.author?.name).toBe("The group's notes");
    expect(embed?.title).toBe('Lore');
    expect(embed?.footer?.text).toBe('v1 · updated 2d ago by the bootstrap');
    expect(selectOf(sent)?.options.map((o) => o.label)).toEqual(['Lore', 'Vibe', 'The MTG crew']);
  });
});

describe('What does Fridge know? (the group, nothing yet)', () => {
  it('says there are no group notes yet in one line', async () => {
    const { response, sent } = await open({ id: BOT, username: 'frigidaire', memberDisplayName: 'Frigidaire' });
    expect(response.content).toBe('no group notes yet, the nightly dream writes them');
    expect(sent.components).toEqual([]);
  });

  it('still offers the owner Edit (to write the first group notes)', async () => {
    const { sent } = await open({ id: BOT, username: 'frigidaire' }, { owners: [DALE] });
    expect(sent.embeds?.[0].description).toBe('no group notes yet, the nightly dream writes them');
    expect(buttonsOf(sent).map((b) => b.label)).toEqual(['Edit']);
  });
});
