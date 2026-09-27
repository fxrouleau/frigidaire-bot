import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory/memoryStore';
import { NotesStore } from '../memory/notes/notesStore';
import { buildCaptureKnowledge, KNOWN_LIMITS } from './knowledge';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';

let memory: MemoryStore;
let notes: NotesStore;
const now = new Date('2026-09-20T12:00:00Z');

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => now });
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'OldDale');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
});

afterEach(() => {
  memory.close();
});

const knowledge = (people: { userId?: string; name: string }[]) => buildCaptureKnowledge({ store: memory, notes, people, now });

const PROFILE = `Remi, the group's night owl.

## Now
Runs day shifts at a bakery (since 2026-08). Organizes Friday drafts.

## Earlier
- Played Valorant 2024–2026.`;

describe('buildCaptureKnowledge', () => {
  it('gives a person with notes their profile (Earlier left out), circles, newer rows and open corrections', async () => {
    await memory.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content: 'Works at a bakery' });
    expect(notes.writeNotes({ scope: 'person', ownerId: REMI }, [{ topic: 'profile', title: 'Remi', content: PROFILE }], { updatedBy: 'dream' }).ok).toBe(true);
    notes.recordDreamSuccess({ scope: 'person', ownerId: REMI }, notes.journalHighWater());
    expect(
      notes.writeCircles(
        [{ slug: 'mtg', title: 'The MTG crew', content: '## Now\nFriday drafts.', aliases: [], members: [{ id: REMI }, { id: DALE }], merged_from: [] }],
        { updatedBy: 'dream' },
      ).ok,
    ).toBe(true);
    await memory.save({ category: 'preference', subject: 'Remi', subject_user_id: REMI, content: 'Hates cilantro' });
    await memory.save({
      category: 'correction',
      subject: 'Remi',
      subject_user_id: REMI,
      said_by: DALE,
      content: 'Moved to Laval, not Longueuil',
    });

    const text = knowledge([{ userId: REMI, name: 'Remi' }]);

    expect(text).toContain(`Remi (id:${REMI}):\nYour notes (updated today):\nRemi, the group's night owl.`);
    expect(text).toContain('Runs day shifts at a bakery');
    expect(text).not.toContain('Played Valorant');
    expect(text).toContain('Their circles: The MTG crew.');
    expect(text).toContain('Newer than the notes:\n- [preference] Remi: Hates cilantro');
    // Already in the notes (below the watermark): not repeated.
    expect(text).not.toContain('Works at a bakery');
    expect(text).toContain('Corrections not in the notes yet:\n- Dale says: Moved to Laval, not Longueuil (today)');
  });

  it("falls back to a person's saved memories while they have no notes, by id and every name", async () => {
    await memory.save({ category: 'fact', subject: 'OldDale', subject_user_id: DALE, content: 'Plays bass' });
    await memory.save({ category: 'fact', subject: 'OldDale', content: 'Owns a husky' });
    await memory.save({ category: 'fact', subject: 'Stranger', content: 'Not in this conversation' });

    const text = knowledge([{ userId: DALE, name: 'Dale' }]);

    expect(text).toContain(`Dale (id:${DALE}):`);
    expect(text).toContain('- [fact] OldDale: Plays bass');
    expect(text).toContain('- [fact] OldDale: Owns a husky');
    expect(text).not.toContain('Not in this conversation');
  });

  it('shows each person once and each row once, and skips people nothing is known about', async () => {
    await memory.save({
      category: 'fact',
      subject: 'Remi',
      subject_user_id: REMI,
      content: 'Best friends with Dale since school',
      related_user_ids: [DALE],
    });
    const text = knowledge([
      { userId: REMI, name: 'Remi' },
      { userId: DALE, name: 'Dale' },
      { userId: REMI, name: 'Remi' },
      { userId: NOVA, name: 'Nova' },
    ]);
    expect(text.match(/Best friends with Dale/g)).toHaveLength(1);
    expect(text.match(/Remi \(id:/g)).toHaveLength(1);
    expect(text).not.toContain('Nova');
  });

  it('knows an unmatched author by name', async () => {
    await memory.save({ category: 'fact', subject: 'Ghost', content: 'Posts at 3am' });
    expect(knowledge([{ name: 'Ghost' }])).toBe('Ghost:\n- [fact] Ghost: Posts at 3am');
  });

  it("gives the server's notes and the server rows newer than them", async () => {
    await memory.save({ category: 'vibe', subject: 'server', content: 'Wings every Friday' });
    expect(knowledge([])).toBe('The server:\n- [vibe] server: Wings every Friday');

    expect(
      notes.writeNotes(
        { scope: 'group' },
        [
          { topic: 'vibe', title: 'Vibe', content: '## Now\nLoud, kind, allergic to mornings.' },
          { topic: 'lore', title: 'Lore', content: `## Now\n${'The great toaster incident. '.repeat(80)}` },
        ],
        { updatedBy: 'dream' },
      ).ok,
    ).toBe(true);
    notes.recordDreamSuccess({ scope: 'group' }, notes.journalHighWater());
    await memory.save({ category: 'vibe', subject: 'server', content: 'Karaoke nights are back' });

    const text = knowledge([]);
    expect(text).toContain('### Vibe\n## Now\nLoud, kind, allergic to mornings.');
    expect(text).toContain('### Lore\n');
    expect(text.length).toBeLessThan(KNOWN_LIMITS.groupNotesMaxChars + 200);
    expect(text).toContain('Newer than the notes:\n- [vibe] server: Karaoke nights are back');
    expect(text).not.toContain('Wings every Friday');
  });

  it('says so when nothing is known', () => {
    expect(knowledge([{ userId: NOVA, name: 'Nova' }])).toBe('(none yet)');
  });

  it("renders rows with the caller's format, and leaves out a person's block past the budget", async () => {
    await memory.save({ category: 'fact', subject: 'Remi', subject_user_id: REMI, content: 'Works at a bakery' });
    await memory.save({ category: 'fact', subject: 'Dale', subject_user_id: DALE, content: 'x'.repeat(300) });
    await memory.save({ category: 'fact', subject: 'Nova', subject_user_id: NOVA, content: 'Plays chess' });
    await memory.save({ category: 'vibe', subject: 'server', content: 'Movie night is Fridays' });
    const text = buildCaptureKnowledge({
      store: memory,
      notes,
      people: [
        { userId: REMI, name: 'Remi' },
        { userId: DALE, name: 'Dale' },
        { userId: NOVA, name: 'Nova' },
      ],
      now,
      rowLine: (row) => `* ${row.subject} said so ${row.seen_count}×: ${row.content}`,
      maxChars: 150,
    });
    expect(text).toContain('* Remi said so 1×: Works at a bakery');
    expect(text).not.toContain('xxx');
    expect(text).toContain('* Nova said so 1×: Plays chess');
    expect(text).not.toContain('Movie night');
  });
});
