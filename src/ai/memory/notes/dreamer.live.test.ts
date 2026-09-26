// Live, paid, opt-in smoke test of memory v2's writers against the real OpenRouter API: a nightly dream of
// one fictional member, the group pass, and an owner edit (MEMORY_DREAM_MODEL / MEMORY_EDIT_MODEL, ZDR-only
// routing). SKIPPED unless RUN_LIVE=1 and OPENROUTER_API_KEY are set.
//
//   docker compose run --rm -e RUN_LIVE=1 -e OPENROUTER_API_KEY=sk-... test yarn test:live
//
// Three calls over a dozen fictional journal rows: roughly ten cents with the default Opus model. Grep the
// output for DREAM_LIVE (status, cost, the written notes, the edit's before/after).
import { describe, expect, it } from 'vitest';
import { config } from '../../../config';
import { CORRECTION_CATEGORY, MemoryStore } from '../memoryStore';
import { type DreamDeps, dreamGroup, dreamPerson, previewChanges, proposeEdit } from './dreamer';
import { NotesStore } from './notesStore';
import { noteShapeWarnings } from './sections';

const RUN_LIVE = process.env.RUN_LIVE === '1' && !!process.env.OPENROUTER_API_KEY;

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';

async function seed(memory: MemoryStore): Promise<void> {
  memory.upsertIdentity(REMI, 'Remi', 'remi_bakes');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
  memory.updateIdentityMeta(REMI, { aliases_add: ['Rems'] });
  const remi = { subject: 'Remi', subject_user_id: REMI, source: 'observation' };
  const rows = [
    { ...remi, category: 'fact', content: 'Works night shifts at a bakery.', observed_at: new Date('2025-03-10T04:00:00Z') },
    { ...remi, category: 'fact', content: 'Plays Valorant most evenings with Dale.', observed_at: new Date('2024-06-01T01:00:00Z'), related_user_ids: [DALE] },
    { ...remi, category: 'personality', content: 'Dry humor; answers questions with questions.', observed_at: new Date('2023-01-15T20:00:00Z') },
    { ...remi, category: 'preference', content: 'Hates pineapple on pizza, loudly.', observed_at: new Date('2026-02-02T23:00:00Z') },
    { ...remi, category: 'event', content: 'Went to a Mario Kart tournament with Dale and Nova last weekend.', related_user_ids: [DALE, NOVA] },
    { ...remi, category: 'fact', content: 'Runs the Friday Magic: The Gathering drafts at the game store; Dale and Nova come most weeks.', related_user_ids: [DALE, NOVA] },
    { ...remi, category: 'fact', content: 'Back in 2017 played Overwatch every night.', observed_at: new Date('2017-05-05T02:00:00Z') },
    {
      ...remi,
      category: CORRECTION_CATEGORY,
      source: 'correction',
      said_by: REMI,
      content: 'Quit Valorant in August 2026; plays Deadlock now.',
    },
    {
      ...remi,
      category: CORRECTION_CATEGORY,
      source: 'correction',
      said_by: DALE,
      content: 'Remi moved to the moon last week.',
    },
    { category: 'vibe', subject: 'server', content: 'Roasting each other is how the group shows affection.' },
    { category: 'vibe', subject: 'server', content: 'Movie night is every other Friday since 2022.' },
  ];
  for (const row of rows) await memory.save(row);
}

describe.skipIf(!RUN_LIVE)('memory dream live (paid, opt-in)', () => {
  it('dreams a fictional member and the group into valid notes, then drafts an owner edit', async () => {
    const memory = new MemoryStore(':memory:');
    await seed(memory);
    const notes = new NotesStore(memory);
    const deps: DreamDeps = { notes, memory, loadPassages: () => [] };

    const person = await dreamPerson(REMI, deps);
    console.log(`DREAM_LIVE person model=${config.dream.model} status=${person.status} cost=${'costUsd' in person ? person.costUsd : '?'}`);
    if (person.status === 'failed') console.log(`DREAM_LIVE person error: ${person.error}`);
    expect(person.status).toBe('updated');
    for (const note of notes.listNotes({ scope: 'person', ownerId: REMI })) {
      console.log(`DREAM_LIVE note ${note.topic} "${note.title}" (${note.content.length} chars):\n${note.content}`);
    }
    for (const { circle } of notes.circlesOf(REMI, { includeFormer: true })) {
      console.log(`DREAM_LIVE circle ${circle.topic} "${circle.title}" members=${circle.members.map((m) => m.memberId).join(',')}:\n${circle.content}`);
    }
    const profile = notes.getProfile(REMI);
    expect(profile?.content).toMatch(/## Now/);
    console.log(`DREAM_LIVE profile shape warnings: ${noteShapeWarnings(profile?.content ?? '', 'profile').join('; ') || 'none'}`);

    const groupOutcome = await dreamGroup(deps, {
      personChanges: person.status === 'updated' ? [{ ownerId: REMI, name: 'Remi', changeSummary: person.changeSummary }] : [],
    });
    console.log(`DREAM_LIVE group status=${groupOutcome.status} cost=${'costUsd' in groupOutcome ? groupOutcome.costUsd : '?'}`);
    expect(groupOutcome.status).toBe('updated');
    for (const note of notes.listNotes({ scope: 'group' })) console.log(`DREAM_LIVE group ${note.topic}:\n${note.content}`);

    const target = { scope: 'person', ownerId: REMI } as const;
    const proposal = await proposeEdit(
      { target, instruction: 'Remove everything about the bakery job; he never worked there.', requestedBy: REMI },
      deps,
    );
    console.log(`DREAM_LIVE edit ok=${proposal.ok} ${proposal.ok ? proposal.changeSummary : proposal.error}`);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const changes = previewChanges(notes, target, proposal.output);
    for (const change of changes) console.log(`DREAM_LIVE edit ${change.kind} ${change.key} ${change.change}:\n${change.after ?? ''}`);
    expect(changes.length).toBeGreaterThan(0);
  }, 900_000);
});
