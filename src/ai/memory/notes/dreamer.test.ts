import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memoryStore';
import { applyEdit, dreamPerson, type EditProposal, previewChanges, proposeEdit } from './dreamer';
import { NotesStore } from './notesStore';
import { validateNotesOutput } from './schema';

const REMI = '100000000000000001';
const DALE = '100000000000000002';
const remi = { scope: 'person', ownerId: REMI } as const;

let memory: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'Dale');
  notes = new NotesStore(memory);
  notes.writeNotes(
    remi,
    [
      { topic: 'profile', title: 'Remi', content: '## Now\nNight shifts.' },
      { topic: 'games', title: 'Games', content: 'Valorant.' },
    ],
    {
      updatedBy: 'dream',
      circles: [{ slug: 'mtg', title: 'The MTG crew', content: 'Drafts.', members: [{ id: REMI }, { id: DALE }] }],
    },
  );
  notes.writeCircles(
    [{ slug: 'magic', title: 'Magic nights', content: 'Same crew.', members: [{ id: REMI }, { id: DALE }] }],
    { updatedBy: 'dream' },
  );
});

afterEach(() => memory.close());

function output(raw: unknown) {
  const result = validateNotesOutput(raw, { scope: 'person' });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.value;
}

describe('previewChanges', () => {
  it('lists changed, added and removed notes and circles, leaving identical drafts out', () => {
    const proposed = output({
      notes: [
        { topic: 'profile', title: 'Remi', content: '## Now\nDay shifts now.' },
        { topic: 'work', title: 'Work', content: 'Bakery.' },
      ],
      removed_topics: ['games'],
      circles: [
        {
          slug: 'mtg',
          title: 'The MTG crew',
          content: 'Drafts.',
          members: [{ id: REMI }, { id: DALE, until: '2026-09' }],
          merged_from: ['magic'],
        },
      ],
      change_summary: 'day shifts',
    });
    const changes = previewChanges(notes, remi, proposed);
    expect(changes.map((c) => [c.kind, c.key, c.change])).toEqual([
      ['note', 'profile', 'changed'],
      ['note', 'work', 'added'],
      ['note', 'games', 'removed'],
      ['circle', 'mtg', 'changed'],
      ['circle', 'magic', 'removed'],
    ]);
    expect(changes[0]).toMatchObject({ before: '## Now\nNight shifts.', after: '## Now\nDay shifts now.' });
    expect(changes[3].membersAfter?.find((m) => m.memberId === DALE)?.until).toBe('2026-09');

    const same = output({ notes: [{ topic: 'games', title: 'Games', content: 'Valorant.' }], change_summary: '' });
    expect(previewChanges(notes, remi, same)).toEqual([]);
  });
});

describe('applyEdit', () => {
  it('saves a confirmed proposal as edit versions with the instruction as the reason', () => {
    const proposal: Extract<EditProposal, { ok: true }> = {
      ok: true,
      target: remi,
      output: output({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nDay shifts.' }], change_summary: 'x' }),
      allowedIds: [],
      changeSummary: 'x',
    };
    const result = applyEdit(proposal, 'he works days now', notes);
    expect(result.ok).toBe(true);
    const profile = notes.getProfile(REMI);
    expect([profile?.updatedBy, notes.getVersion(profile?.id ?? 0, 2)?.reason]).toEqual(['edit', 'he works days now']);
  });
});

describe('model-backed writers', () => {
  it('are not implemented until the dream part lands', async () => {
    const deps = { notes, memory };
    await expect(dreamPerson(REMI, deps)).rejects.toThrow('not implemented: dreamPerson');
    await expect(
      proposeEdit({ target: remi, instruction: 'x', requestedBy: REMI }, deps),
    ).rejects.toThrow('not implemented: proposeEdit');
  });
});
