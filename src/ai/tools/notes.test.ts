import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeMessage } from '../../test-support/fakeDiscord';
import { getNotesStore, setMemoryStoreForTesting } from '../memory';
import { parseEvidence } from '../memory/evidence';
import { MemoryStore } from '../memory/memoryStore';
import type { NotesStore } from '../memory/notes/notesStore';
import { toolDefinitions } from '../tools';
import { createTurnEffects, type ToolDefinition, type ToolHandlerContext } from '../types';
import { MAX_CORRECTIONS_PER_DAY, notesTools, recentCorrectionCount } from './notes';

// Fictional cast, placeholder snowflakes.
const REMI = '700000000000000001';
const DALE = '700000000000000002';
const NOVA = '700000000000000003';
const NOW = new Date('2026-09-25T14:00:00Z');

let memory: MemoryStore;
let notes: NotesStore;

function tool(name: string): ToolDefinition {
  const found = notesTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function run(name: string, args: Record<string, unknown>, authorId = REMI, content = 'fridge that is wrong') {
  const { message } = createFakeMessage({
    messageId: '1300000000000000001',
    authorId,
    authorDisplayName: authorId === REMI ? 'Remi' : authorId === DALE ? 'Dale' : 'Nova',
    content,
  });
  const ctx = { message, channelId: message.channel.id, turn: createTurnEffects() } as unknown as ToolHandlerContext;
  return tool(name).handler(ctx, args);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memory = new MemoryStore(':memory:');
  setMemoryStoreForTesting(memory);
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
  memory.updateIdentityMeta(DALE, { irl_name: 'Dorian' });
  notes = getNotesStore(memory);
  notes.writeNotes(
    { scope: 'person', ownerId: REMI },
    [
      {
        topic: 'profile',
        title: 'Remi',
        content: '## Now\nRuns day shifts at a bakery.\n\n## Earlier\n- Back in 2017 played Overwatch nightly.',
      },
      { topic: 'games', title: 'Games', content: 'Valorant since 2024.' },
    ],
    { updatedBy: 'dream' },
  );
  notes.writeNotes({ scope: 'group' }, [{ topic: 'lore', title: 'Lore', content: 'The great bakery heist of 2022.' }], {
    updatedBy: 'dream',
  });
  notes.writeCircles(
    [
      {
        slug: 'mtg',
        title: 'The MTG crew',
        content: 'Friday drafts at the game store.',
        aliases: ['the drafters'],
        members: [
          { id: REMI, since: '2021', role: 'organizer' },
          { id: DALE, since: '2021', until: '2023' },
          { id: NOVA, since: '2024' },
        ],
      },
    ],
    { updatedBy: 'dream' },
  );
});

afterEach(() => {
  vi.useRealTimers();
  setMemoryStoreForTesting(undefined);
});

describe('registration', () => {
  it('offers the notes tools to the chat model', () => {
    expect(toolDefinitions.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_notes', 'read_note', 'search_notes', 'record_correction']),
    );
  });
});

describe('list_notes', () => {
  it("lists a person's topics and circles, former ones marked", async () => {
    const remi = await run('list_notes', { person: 'me' });
    expect(remi).toContain('Notes on Remi:\n- profile: "Remi" (');
    expect(remi).toContain('- games: "Games" (20 chars, updated today)');
    expect(remi).toContain('Circles:\n- mtg: "The MTG crew" (since 2021, 32 chars, updated today)');

    const dale = await run('list_notes', { person: 'Dorian' });
    expect(dale).toContain('No notes on Dale yet');
    expect(dale).toContain('- mtg: "The MTG crew" (former member, 2021–2023, ');
  });

  it('lists everyone, the group and every circle without a person', async () => {
    const all = await run('list_notes', {});
    expect(all).toContain('People:\n- Remi: profile, games (profile updated today)');
    expect(all).toContain('The group:\n- lore: "Lore"');
    expect(all).toContain('Circles:\n- mtg: "The MTG crew" (Remi, Nova)');
  });

  it('counts journal rows and corrections newer than the notes', async () => {
    await memory.save({ category: 'fact', subject: 'Remi', content: 'adopted a cat', subject_user_id: REMI });
    await run('record_correction', { person: 'me', correction: 'Quit Valorant in August.' });
    expect(await run('list_notes', { person: 'Remi' })).toContain('Newer than the notes: 2 journal entries (1 correction).');
  });
});

describe('read_note', () => {
  it('reads the whole profile, Earlier included, with corrections newer than it', async () => {
    await run('record_correction', { person: 'Remi', correction: 'Works nights again.' }, DALE);
    const text = await run('read_note', { person: 'Remi' });
    expect(text).toContain('Remi · Remi (v1, updated today by dream)');
    expect(text).toContain('Back in 2017 played Overwatch nightly.');
    expect(text).toContain('Corrections newer than this note (they win over it):\n- Dale says: Works nights again. (today)');
  });

  it('reads a topic, a group note and a circle by slug, title, alias or as a topic of a member', async () => {
    expect(await run('read_note', { person: 'Remi', topic: 'games' })).toContain('Valorant since 2024.');
    expect(await run('read_note', { person: 'group', topic: 'lore' })).toContain('bakery heist');
    const circle = await run('read_note', { circle: 'the drafters' });
    expect(circle).toContain(
      'The MTG crew (circle "mtg"; also called the drafters; members: Remi (since 2021, organizer), Nova (since 2024); formerly Dale (2021–2023); v1, updated today by dream)',
    );
    expect(await run('read_note', { circle: 'MTG' })).toContain('Friday drafts');
    expect(await run('read_note', { topic: 'mtg' })).toContain('Friday drafts');
    expect(await run('read_note', { person: 'Nova', topic: 'mtg' })).toContain('Friday drafts');
  });

  it('says what exists when a note is missing', async () => {
    expect(await run('read_note', { person: 'Remi', topic: 'work' })).toBe(
      'Remi has no "work" note. Topics: profile, games; circles: mtg.',
    );
    expect(await run('read_note', { circle: 'chess club' })).toBe('No circle "chess club". Circles: mtg.');
    expect(await run('read_note', { person: 'Remi', topic: 'Not A Slug!' })).toContain('is not a topic');
  });
});

describe('search_notes', () => {
  it('finds person, group and circle notes, old history included', async () => {
    const text = await run('search_notes', { query: 'bakery' });
    expect(text).toContain('- Remi · profile: ');
    expect(text).toContain('- the group · lore: ');
    expect(await run('search_notes', { query: 'Overwatch' })).toContain('**Overwatch**');
    expect(await run('search_notes', { query: 'drafters' })).toContain('circle "The MTG crew" (circle: mtg)');
    expect(await run('search_notes', { query: 'unicorn' })).toContain('No notes mention "unicorn"');
  });
});

describe('record_correction', () => {
  it("records a self-correction as authoritative, with the speaker and the message as evidence", async () => {
    const reply = await run('record_correction', { person: 'me', correction: 'Quit Valorant in August 2026.' });
    expect(reply).toMatch(/^Recorded \(id: \d+\) as Remi's own correction: it's authoritative/);
    const [row] = notes.openCorrections({ scope: 'person', ownerId: REMI });
    expect(row).toMatchObject({
      category: 'correction',
      subject: 'Remi',
      subject_user_id: REMI,
      said_by: REMI,
      source: 'correction',
      content: 'Quit Valorant in August 2026.',
    });
    expect(parseEvidence(row.evidence)).toEqual({ messageIds: ['1300000000000000001'], quote: 'fridge that is wrong' });
  });

  it("records a correction about someone else as the speaker's claim, and about the group", async () => {
    expect(await run('record_correction', { person: 'Remi', correction: 'Moved to Laval.' }, DALE)).toContain(
      "as Dale's claim about Remi: it shows next to your notes, and tonight's dream weighs it against what else you know (Remi's own word would win)",
    );
    expect(await run('record_correction', { person: 'group', correction: 'Movie night moved to Saturdays.' })).toContain(
      "as Remi's claim about the group",
    );
    expect(notes.openCorrections({ scope: 'group' }).map((m) => m.content)).toEqual(['Movie night moved to Saturdays.']);
  });

  it('refuses empty, overlong and unknown-person corrections', async () => {
    expect(await run('record_correction', { person: 'me', correction: '  ' })).toContain('was empty');
    expect(await run('record_correction', { person: 'me', correction: 'x'.repeat(401) })).toContain('under 400');
    expect(await run('record_correction', { person: 'Zebulon', correction: 'x' })).toMatch(/^Nothing recorded\. /);
  });

  it('takes at most MAX_CORRECTIONS_PER_DAY from one member in a rolling 24 hours', async () => {
    // Earlier corrections by Remi (a raw insert: distinct rows, stamped with SQLite's clock like save()'s).
    const insert = memory
      .sharedDatabase()
      .prepare(
        "INSERT INTO memories (category, subject, content, source, subject_user_id, said_by) VALUES ('correction', 'Dale', ?, 'correction', ?, ?)",
      );
    for (let i = 0; i < MAX_CORRECTIONS_PER_DAY - 1; i++) insert.run(`Claim number ${i}.`, DALE, REMI);
    expect(recentCorrectionCount(memory, REMI)).toBe(MAX_CORRECTIONS_PER_DAY - 1);

    expect(await run('record_correction', { person: 'me', correction: 'Quit Valorant in August 2026.' })).toMatch(
      /^Recorded/,
    );
    const capped = await run('record_correction', { person: 'me', correction: 'Plays Deadlock now.' });
    expect(capped).toMatch(/^Nothing recorded: Remi has already filed 15 corrections in the last 24 hours/);
    expect(capped).toContain('in your own voice');
    expect(notes.openCorrections({ scope: 'person', ownerId: REMI }).map((m) => m.content)).toEqual([
      'Quit Valorant in August 2026.',
    ]);

    // Someone else is not affected, and a day later Remi can correct again.
    expect(await run('record_correction', { person: 'Remi', correction: 'Moved to Laval.' }, DALE)).toMatch(/^Recorded/);
    memory.sharedDatabase().prepare("UPDATE memories SET updated_at = datetime('now', '-25 hours') WHERE said_by = ?").run(REMI);
    expect(recentCorrectionCount(memory, REMI)).toBe(0);
    expect(await run('record_correction', { person: 'me', correction: 'Plays Deadlock now.' })).toMatch(/^Recorded/);
  });
});
