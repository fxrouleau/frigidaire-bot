import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CapturedRequest,
  chatCompletionBody,
  createCapturingClient,
  type ScriptedReply,
} from '../../../test-support/capturingClient';
import { MemoryStore } from '../memoryStore';
import {
  applyEdit,
  creditCircleActivity,
  type DreamDeps,
  dreamPerson,
  LIFECYCLE_FAILED_KEY,
  previewChanges,
  proposeEdit,
  runLifecycle,
  runNightlyDream,
} from './dreamer';
import { ARCHIVE_TRACE_SYSTEM, OCCASION_HISTORY_SYSTEM } from './dreamPrompts';
import { CIRCLE_DECAY, circlePresence, UNDO_KEEPS_DAYS } from './lifecycle';
import { NotesStore } from './notesStore';
import { NOTE_LIMITS, validateNotesOutput } from './schema';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const JASPER = '100000000000000004';
const remi = { scope: 'person', ownerId: REMI } as const;
const NOW = new Date('2026-10-06T08:30:00Z'); // 04:30 Eastern

let memory: MemoryStore;
let notes: NotesStore;

beforeEach(() => {
  memory = new MemoryStore(':memory:');
  memory.upsertIdentity(REMI, 'Remi');
  memory.upsertIdentity(DALE, 'Dale');
  memory.upsertIdentity(NOVA, 'Nova');
  memory.upsertIdentity(JASPER, 'Jasper');
  notes = new NotesStore(memory, { now: () => NOW });
  notes.writeNotes(remi, [{ topic: 'profile', title: 'Remi', content: '## Now\nNight shifts.' }], {
    updatedBy: 'dream',
  });
});

afterEach(() => {
  memory.close();
  vi.unstubAllEnvs();
});

function reply(answer: unknown, cost = 0.01): ScriptedReply {
  const body = chatCompletionBody(typeof answer === 'string' ? answer : JSON.stringify(answer)) as {
    usage?: unknown;
  };
  body.usage = { prompt_tokens: 1000, completion_tokens: 300, cost };
  return { body };
}

function messagesOf(request: CapturedRequest): { role: string; content: string }[] {
  return request.body.messages as { role: string; content: string }[];
}

function deps(client: DreamDeps['client']): DreamDeps {
  return { notes, memory, client, now: () => NOW, loadPassages: () => [] };
}

const trip = (over: Record<string, unknown> = {}) => ({
  slug: 'ski-trip-2027',
  title: 'Ski trip',
  content: '## Plan\nA week at Tremblant; chalet booked, lift passes still open.',
  starts_on: '2027-01-10',
  ends_on: '2027-01-17',
  place: 'Tremblant',
  participants: [{ id: REMI, role: 'organizer' }, { id: DALE }],
  ...over,
});

const circle = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  title: `The ${slug} crew`,
  content: `## Now\n${slug} nights.`,
  members: [
    { id: REMI, since: '2018' },
    { id: DALE, since: '2018' },
  ],
  ...over,
});

/** A row about Remi, observed now, also about `related`. */
function remiRow(content: string, related: string[] = [], day = '2026-10-04') {
  return memory.save({
    category: 'event',
    subject: 'Remi',
    subject_user_id: REMI,
    content,
    source: 'observation',
    related_user_ids: related,
    observed_at: new Date(`${day}T18:00:00Z`),
  });
}

describe("a person's dream input", () => {
  it('shows their occasions in full, archived ones and archived circles one line each, former and fading circles as excerpts', async () => {
    notes.writeOccasions([trip(), trip({ slug: 'lan-2025', title: 'The 2025 LAN', starts_on: '2025-03-01', ends_on: null })], {
      updatedBy: 'dream',
    });
    notes.archiveNote(notes.getOccasion('lan-2025')?.id ?? 0, { updatedBy: 'dream', content: 'A weekend LAN.' });
    notes.writeCircles(
      [
        circle('mtg'),
        circle('chess', { members: [{ id: REMI, since: '2020', until: '2024' }, { id: DALE }] }),
        circle('tarkov'),
        circle('yugioh'),
      ],
      { updatedBy: 'dream' },
    );
    notes.recordActivity(notes.getCircle('tarkov')?.id ?? 0, { '2026-06': 4, '2026-07': 4 }, { mode: 'add' });
    notes.recordActivity(notes.getCircle('mtg')?.id ?? 0, { '2025-02': 12, '2026-02': 12 }, { mode: 'add' });
    notes.archiveNote(notes.getCircle('yugioh')?.id ?? 0, { updatedBy: 'dream', content: '## History\nDuels 2018–2020.' });
    await remiRow('Works day shifts now.');

    const { client, requests } = createCapturingClient([
      reply({ notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nDay shifts.' }], change_summary: 'days' }),
    ]);
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'updated' });
    const [system, user] = messagesOf(requests[0]);
    expect(system.content).toContain('An occasion is a note about one notable thing specific members do together');
    expect(system.content).toContain('A circle is a shared thing: one person doing it alone goes in their own notes');
    expect(user.content).toContain(
      '<occasion slug="ski-trip-2027" title="Ski trip" version="1" starts_on="2027-01-10" ends_on="2027-01-17" place="Tremblant" status="planned" today="planned, starts in 96 days"',
    );
    expect(user.content).toContain(`  - Remi (id:${REMI}; in, organizer)`);
    expect(user.content).toContain('Archived occasions (history: never write or remove them):\n- lan-2025 "The 2025 LAN" (archived; 2025-03-01, Tremblant; with Remi (organizer), Dale)');
    // Present and theirs: in full, with its rhythm.
    expect(user.content).toMatch(/<circle slug="mtg" [^>]*last_active="Feb 2026" cadence="yearly \(Feb\)" size=/);
    // Left it: an excerpt. Fading: an excerpt, said so.
    expect(user.content).toMatch(/<circle slug="chess" [^>]*shown="excerpt only">/);
    expect(user.content).toMatch(/<circle slug="tarkov" [^>]*presence="fading"[^>]*shown="excerpt only">/);
    expect(user.content).toContain(
      'Archived circles (history: never write, remove or merge them, unless the entries name one that is back):\n- yugioh "The yugioh crew" (archived; members: ',
    );
  });
});

describe('reviving an archived circle', () => {
  beforeEach(() => {
    notes.writeCircles([circle('yugioh', { title: 'The Yu-Gi-Oh crew' })], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    notes.recordActivity(id, { '2019-03': 20, '2019-04': 20, '2020-01': 20 }, { mode: 'max' });
    notes.archiveNote(id, { updatedBy: 'dream', content: '## History\nFriday duels 2018–2020.' });
  });

  it("never counts one member's rows: no activity, no revival, and the circle stays a line", async () => {
    await remiRow('Plays GOAT-format Yu-Gi-Oh again.');
    const id = notes.getCircle('yugioh')?.id ?? 0;
    const before = notes.activityOf(id);
    const rows = notes.newJournal(remi, { dream: true });
    expect(creditCircleActivity(notes, rows, [notes.getCircle('yugioh') as never]).revived).toEqual([]);
    expect(notes.activityOf(id)).toEqual(before);
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
  });

  it('credits a pair row that names no circle only to present circles, as ambient, and never revives', async () => {
    notes.writeCircles([circle('climbing'), circle('mtg')], { updatedBy: 'dream' });
    const climbing = notes.getCircle('climbing')?.id ?? 0;
    const mtg = notes.getCircle('mtg')?.id ?? 0;
    notes.recordActivity(climbing, { '2026-08': 12, '2026-09': 12 }, { mode: 'max' });
    notes.recordActivity(mtg, { '2025-01': 12 }, { mode: 'max' }); // long faded: not present
    const yugioh = notes.getCircle('yugioh')?.id ?? 0;
    const yugiohBefore = notes.activityOf(yugioh);
    const pairRows = [
      'Remi and Dale moved in together.',
      'Painted the new kitchen with Dale.',
      'Adopted a cat with Dale.',
      'Hosted a housewarming with Dale.',
      'Argued with Dale over the thermostat.',
    ];
    for (const content of pairRows) await remiRow(content, [DALE]);
    const rows = notes.newJournal(remi, { dream: true });
    const circles = ['climbing', 'mtg', 'yugioh'].map((slug) => notes.getCircle(slug) as never);
    expect(creditCircleActivity(notes, rows, circles, 'dream', '2026-10-06').revived).toEqual([]);
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
    expect(notes.activityOf(yugioh)).toEqual(yugiohBefore);
    expect(notes.activityOf(mtg)).toEqual([{ month: '2025-01', weight: 12 }]);
    // Ambient, capped per month, and never a real month.
    expect(notes.activityOf(climbing).at(-1)).toEqual({ month: '2026-10', weight: 0, ambient: CIRCLE_DECAY.ambientMonthCap });
    expect(circlePresence(notes.getCircle('climbing') as never, notes.activityOf(climbing), '2026-10-06').lastActive).toBe(
      '2026-09',
    );
  });

  it('postpones a revival by activity that would pass the circle limit, and keeps other writes going', async () => {
    // Placeholder members, two per circle, so no one passes the per-member limit.
    const member = (n: number) => `1000000000009${String(n).padStart(5, '0')}`;
    for (let n = 0; n < 2 * NOTE_LIMITS.maxCircles; n++) memory.upsertIdentity(member(n), `Member ${n}`);
    const fillers = Array.from({ length: NOTE_LIMITS.maxCircles }, (_, i) =>
      circle(`filler-${i}`, { members: [{ id: member(2 * i), since: '2020' }, { id: member(2 * i + 1), since: '2020' }] }),
    );
    for (let i = 0; i < fillers.length; i += 10) {
      expect(notes.writeCircles(fillers.slice(i, i + 10), { updatedBy: 'dream' }).ok).toBe(true);
    }
    expect(notes.listCircles()).toHaveLength(NOTE_LIMITS.maxCircles);
    for (const content of [
      'Dueled Dale at yugioh with a dragon deck.',
      'Traded yugioh holographic rares with Dale.',
      'Built a yugioh spellcaster list with Dale.',
      'Lost three yugioh matches to Dale on Friday.',
    ])
      await remiRow(content, [DALE]);
    const rows = notes.newJournal(remi, { dream: true });
    expect(creditCircleActivity(notes, rows, [notes.getCircle('yugioh') as never], 'dream', '2026-10-06').revived).toEqual(
      [],
    );
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
    // The activity is kept: it comes back once there is room.
    expect(notes.activityOf(notes.getCircle('yugioh')?.id ?? 0).at(-1)).toMatchObject({ month: '2026-10', weight: 12 });
    // An unrelated rewrite still saves.
    const rewrite = notes.writeCircles([{ ...fillers[0], content: '## Now\nStill going.' }], { updatedBy: 'dream' });
    expect(rewrite.ok).toBe(true);
    // A store already over the limit (a revival from before the limit was checked) refuses only what adds to it.
    memory.sharedDatabase().prepare("UPDATE notes SET status = NULL WHERE scope = 'circle' AND topic = 'yugioh'").run();
    expect(notes.listCircles()).toHaveLength(NOTE_LIMITS.maxCircles + 1);
    expect(notes.writeCircles([{ ...fillers[1], content: '## Now\nAlso going.' }], { updatedBy: 'dream' }).ok).toBe(true);
    expect(notes.writeCircles([circle('newcomer')], { updatedBy: 'dream' })).toEqual({
      ok: false,
      errors: [`${NOTE_LIMITS.maxCircles + 2} circles, over the limit of ${NOTE_LIMITS.maxCircles}`],
    });
  });

  it("refuses a dream's revival when no row names the circle", async () => {
    await remiRow('Spent the weekend with Dale.', [DALE]);
    const answer = {
      notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nNight shifts.' }],
      circles: [{ ...circle('yugioh', { title: 'The Yu-Gi-Oh crew', content: '## Now\nBack.' }) }],
      change_summary: 'back',
    };
    const { client, requests } = createCapturingClient([reply(answer), reply(answer)]);
    expect(await dreamPerson(REMI, deps(client))).toMatchObject({ status: 'failed' });
    expect(messagesOf(requests[1]).at(-1)?.content).toContain(
      'circle "yugioh" is archived and no new journal row names it with two or more of its members',
    );
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
  });

  it('brings it back on two former members together: present when substantial, provisional when not', async () => {
    const id = notes.getCircle('yugioh')?.id ?? 0;
    expect(notes.getCircle('yugioh')?.members.every((m) => m.until !== null)).toBe(true);
    const shared = [
      'Dueled Dale at yugioh with a dragon deck.',
      'Traded yugioh holographic rares with Dale.',
      'Built a yugioh spellcaster list with Dale.',
      'Lost three yugioh matches to Dale on Friday.',
    ];
    expect(shared.length * CIRCLE_DECAY.dreamRowWeight).toBeGreaterThanOrEqual(CIRCLE_DECAY.realReturnWeight);
    for (const content of shared) await remiRow(content, [DALE]);
    const rows = notes.newJournal(remi, { dream: true });
    const { revived } = creditCircleActivity(notes, rows, [notes.getCircle('yugioh') as never], 'dream', '2026-10-06');
    expect(revived.map((c) => c.topic)).toEqual(['yugioh']);
    const back = notes.getCircle('yugioh');
    expect(back?.status).toBeNull();
    // The members behind the comeback are current again.
    expect(back?.members.map((m) => [m.memberId, m.until])).toEqual([
      [REMI, null],
      [DALE, null],
    ]);
    expect(notes.activityOf(id).at(-1)).toEqual({
      month: '2026-10',
      weight: shared.length * CIRCLE_DECAY.dreamRowWeight,
      revival: true,
    });
    expect(circlePresence(back as never, notes.activityOf(id), '2026-10-20').state).toBe('present');

    // A smaller shared return elsewhere: back, but only provisionally (fading).
    notes.writeCircles([circle('dbfz')], { updatedBy: 'dream' });
    const dbfz = notes.getCircle('dbfz')?.id ?? 0;
    notes.recordActivity(dbfz, { '2020-05': 30 }, { mode: 'max' });
    notes.archiveNote(dbfz, { updatedBy: 'dream', content: 'A trace.' });
    const small = await remiRow('Played some DBFZ with Dale.', [DALE]);
    const smallRows = notes.newJournal(remi, { dream: true }).filter((r) => r.id === small);
    creditCircleActivity(notes, smallRows, [notes.getCircle('dbfz') as never], 'dream', '2026-10-06');
    expect(notes.getCircle('dbfz')?.status).toBeNull();
    expect(circlePresence(notes.getCircle('dbfz') as never, notes.activityOf(dbfz), '2026-10-20')).toMatchObject({
      state: 'fading',
      provisional: true,
    });
  });

  it("refuses a dream's revival without two current members (repair), then saves the shared comeback", async () => {
    await remiRow('Dueled Dale at yugioh at the card shop again.', [DALE]);
    const back = (members: unknown[]) => ({
      notes: [{ topic: 'profile', title: 'Remi', content: '## Now\nNight shifts. Dueling again.' }],
      circles: [{ ...circle('yugioh', { title: 'The Yu-Gi-Oh crew', content: '## Now\nBack to Friday duels.' }), members }],
      change_summary: 'back to Yu-Gi-Oh',
    });
    const { client, requests } = createCapturingClient([
      reply(back([{ id: REMI, since: '2018' }, { id: DALE, since: '2018', until: '2020' }])),
      reply(back([{ id: REMI, since: '2018' }, { id: DALE, since: '2018' }])),
    ]);
    const outcome = await dreamPerson(REMI, deps(client));
    expect(outcome).toMatchObject({ status: 'updated' });
    expect(messagesOf(requests[1]).at(-1)?.content).toContain(
      'circle "yugioh" is archived: bring it back only when at least two of its members are doing it together again',
    );
    // Shown in full (a shared row names it), so it could be written; now live again, a real return.
    expect(messagesOf(requests[0])[1].content).toMatch(/<circle slug="yugioh" [^>]*status="archived"/);
    const yugioh = notes.getCircle('yugioh');
    expect(yugioh?.status).toBeNull();
    expect(circlePresence(yugioh as never, notes.activityOf(yugioh?.id ?? 0), '2026-10-20').state).toBe('present');
  });
});

describe('runLifecycle', () => {
  it('rewrites an occasion that ended as history (one ZDR memory_dream call), keeping its participants', async () => {
    notes.writeOccasions(
      [trip({ slug: 'orchard-trip', title: 'Orchard trip', starts_on: '2026-10-03', ends_on: null, status: 'planned', content: '## Plan\nSaturday at the orchard; Remi drives.' })],
      { updatedBy: 'dream' },
    );
    await remiRow('Orchard trip: Dale fell off the ladder, nobody let it go.', [DALE], '2026-10-04');
    const { client, requests } = createCapturingClient([
      reply({
        occasions: [
          trip({
            slug: 'orchard-trip',
            title: 'Orchard trip',
            starts_on: '2026-10-03',
            ends_on: null,
            status: 'past',
            content: '## What happened\nA day at the orchard; Dale fell off the ladder.\n\n## Legacy\n"Ladder Dale."',
          }),
        ],
        change_summary: 'orchard trip happened',
      }),
    ]);
    const run = await runLifecycle(deps(client), NOW);
    expect(run.outcomes).toMatchObject([{ status: 'history', changeSummary: 'orchard trip happened' }]);
    const occasion = notes.getOccasion('orchard-trip');
    expect(occasion).toMatchObject({ status: 'past', version: 2, updatedBy: 'dream' });
    expect(occasion?.content).toContain('## Legacy');
    expect(requests[0].headers.get('X-Frigidaire-Feature')).toBe('memory_dream');
    expect(requests[0].body).toMatchObject({ provider: { zdr: true }, max_tokens: 32_000 });
    const [system, user] = messagesOf(requests[0]);
    expect(system.content).toBe(OCCASION_HISTORY_SYSTEM);
    expect(user.content).toContain('THE OCCASION:\n<occasion slug="orchard-trip"');
    expect(user.content).toContain('JOURNAL (1 entry, oldest first):');
    expect(user.content).toContain('Dale fell off the ladder');
    // Done: nothing left to rewrite.
    expect((await runLifecycle(deps(createCapturingClient([]).client), NOW)).outcomes).toEqual([]);
  });

  it('asks again when the rewrite leaves it planned although it is over, or drops someone', async () => {
    notes.writeOccasions([trip({ slug: 'bbq', title: 'BBQ', starts_on: '2026-09-27', ends_on: null, status: 'planned' })], {
      updatedBy: 'dream',
    });
    const answer = (over: Record<string, unknown>) =>
      reply({ occasions: [trip({ slug: 'bbq', title: 'BBQ', starts_on: '2026-09-27', ends_on: null, ...over })], change_summary: 'x' });
    const { client, requests } = createCapturingClient([
      answer({ status: 'planned', content: '## What happened\nBurgers.' }),
      answer({ status: 'past', content: '## What happened\nBurgers.', participants: [{ id: REMI }, { id: NOVA }] }),
    ]);
    const run = await runLifecycle(deps(client), NOW);
    expect(messagesOf(requests[1]).at(-1)?.content).toContain('it is over by its dates (2026-09-27)');
    expect(run.outcomes).toMatchObject([{ status: 'failed', task: 'history', slug: 'bbq', cause: 'answer' }]);
    expect(notes.getOccasion('bbq')?.status).toBe('planned');
  });

  it('archives a circle that faded out with a compacted trace (one small call), its activity in the prompt', async () => {
    notes.writeCircles([circle('tarkov')], { updatedBy: 'dream' });
    const id = notes.getCircle('tarkov')?.id ?? 0;
    notes.recordActivity(id, { '2025-01': 3, '2025-02': 3, '2025-03': 3 }, { mode: 'add' });
    const trace = '## History\nRemi and Dale raided Tarkov in early 2025.\n\n## Legacy\n"Never go to Customs."';
    const { client, requests } = createCapturingClient([reply(trace, 0.002)]);
    const run = await runLifecycle(deps(client), NOW);
    expect(run.outcomes).toMatchObject([{ status: 'archived', why: 'dormant', costUsd: 0.002 }]);
    const archived = notes.getCircle('tarkov');
    expect(archived).toMatchObject({ status: 'archived', content: trace });
    expect(archived?.members.map((m) => m.until)).toEqual(['2026-10', '2026-10']);
    expect(notes.getVersions(id)[0].reason).toBe('archived as a trace: it faded out, nothing shared in a long time');
    const [system, user] = messagesOf(requests[0]);
    expect(system.content).toBe(ARCHIVE_TRACE_SYSTEM);
    expect(user.content).toContain(
      'Archiving a circle that faded out (nothing its members shared has come up in a long time): the circle "The tarkov crew" (tarkov).',
    );
    expect(user.content).toContain('ITS ACTIVITY');
    expect(user.content).toContain('- last really active Mar 2025');
    expect(requests[0].headers.get('X-Frigidaire-Feature')).toBe('memory_dream');
    expect(requests[0].body).toMatchObject({ provider: { zdr: true } });
  });

  it('notes a brief revival in the trace when a provisional comeback faded again', async () => {
    notes.writeCircles([circle('yugioh')], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    const monthly = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [`${2019 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 5]),
    );
    notes.recordActivity(id, monthly, { mode: 'max' });
    notes.recordActivity(id, { '2026-05': 2 }, { mode: 'add' });
    memory
      .sharedDatabase()
      .prepare("UPDATE note_activity SET revival = 1 WHERE note_id = ? AND month = '2026-05'")
      .run(id);
    const { client, requests } = createCapturingClient([reply('## History\nDuels 2019–2020; came back briefly in May 2026.')]);
    const run = await runLifecycle(deps(client), NOW);
    expect(run.outcomes).toMatchObject([{ status: 'archived' }]);
    expect(messagesOf(requests[0])[1].content).toContain('- brief revival May 2026');
  });

  it('fails an archive whose trace never fits, and leaves the circle live for the next night', async () => {
    notes.writeCircles([circle('chess')], { updatedBy: 'dream' });
    notes.recordActivity(notes.getCircle('chess')?.id ?? 0, { '2024-01': 3 }, { mode: 'add' });
    const long = 'x '.repeat(NOTE_LIMITS.archivedMaxChars);
    const { client, requests } = createCapturingClient([reply(long), reply(long)]);
    const run = await runLifecycle(deps(client), NOW);
    expect(requests).toHaveLength(2);
    expect(run.outcomes).toMatchObject([{ status: 'failed', task: 'archive', slug: 'chess', cause: 'answer' }]);
    expect(notes.getCircle('chess')?.status).toBeNull();
  });

  it('tries a note that failed on the answer only after the untried ones, and forgets the failure once it works', async () => {
    notes.writeCircles([circle('chess')], { updatedBy: 'dream' });
    const chess = notes.getCircle('chess');
    notes.recordActivity(chess?.id ?? 0, { '2024-01': 3 }, { mode: 'add' });
    const long = 'x '.repeat(NOTE_LIMITS.archivedMaxChars);
    await runLifecycle(deps(createCapturingClient([reply(long), reply(long)]).client), NOW);
    expect(JSON.parse(memory.getState(LIFECYCLE_FAILED_KEY) ?? '{}')).toEqual({ [String(chess?.id)]: chess?.version });

    // A fainter circle due later than chess would normally come after it; untried, it goes first now.
    notes.writeCircles([circle('go')], { updatedBy: 'dream' });
    notes.recordActivity(notes.getCircle('go')?.id ?? 0, { '2025-06': 3 }, { mode: 'add' });
    const { client, requests } = createCapturingClient([reply('## History\nGo nights.'), reply('## History\nChess.')]);
    const run = await runLifecycle(deps(client), NOW);
    expect(run.outcomes.map((o) => (o.status === 'archived' ? o.note.topic : o.status))).toEqual(['go', 'chess']);
    expect(messagesOf(requests[0])[1].content).toContain('(go)');
    expect(JSON.parse(memory.getState(LIFECYCLE_FAILED_KEY) ?? '{}')).toEqual({});
  });

  it("leaves an archive the owner undid alone for UNDO_KEEPS_DAYS, then archives it again", async () => {
    notes.writeOccasions(
      [trip({ slug: 'lan-2026', title: 'The 2026 LAN', starts_on: '2026-06-01', ends_on: '2026-06-02', status: 'past' })],
      { updatedBy: 'dream' },
    );
    await runLifecycle(deps(createCapturingClient([reply('## History\nA weekend LAN.')]).client), NOW);
    const lan = notes.getOccasion('lan-2026');
    expect(lan?.status).toBe('archived');
    expect(notes.undo(lan?.id ?? 0)).toMatchObject({ ok: true });
    expect(notes.getOccasion('lan-2026')).toMatchObject({ status: 'past', updatedBy: 'undo' });
    const quiet = createCapturingClient([]);
    expect((await runLifecycle(deps(quiet.client), NOW)).outcomes).toEqual([]);
    expect(quiet.requests).toHaveLength(0);
    const later = new Date(NOW.getTime() + UNDO_KEEPS_DAYS * 24 * 60 * 60_000);
    const again = await runLifecycle(deps(createCapturingClient([reply('## History\nA weekend LAN.')]).client), later);
    expect(again.outcomes).toMatchObject([{ status: 'archived', why: 'ended' }]);
  });

  it('archives an occasion months after it ended, and counts a linked occasion that happened as its circle’s activity', async () => {
    notes.writeCircles([circle('winter-dinners', { title: 'Winter dinners' })], { updatedBy: 'dream' });
    const dinners = notes.getCircle('winter-dinners')?.id ?? 0;
    notes.recordActivity(dinners, { '2023-01': 12, '2024-01': 12 }, { mode: 'max' });
    notes.archiveNote(dinners, { updatedBy: 'dream', content: 'A tradition.' });
    notes.writeOccasions(
      [
        trip({ slug: 'dinner-2026', title: 'Winter dinner 2026', starts_on: '2026-10-02', ends_on: null, status: 'past', circle: 'winter-dinners' }),
        trip({ slug: 'lan-2026', title: 'The 2026 LAN', starts_on: '2026-06-01', ends_on: '2026-06-02', status: 'past' }),
      ],
      { updatedBy: 'dream' },
    );
    const { client } = createCapturingClient([reply('## History\nA weekend LAN in June 2026.')]);
    const run = await runLifecycle(deps(client), NOW);
    expect(run.revived.map((c) => c.topic)).toEqual(['winter-dinners']);
    expect(notes.getCircle('winter-dinners')?.status).toBeNull();
    expect(notes.activityOf(dinners).at(-1)).toEqual({ month: '2026-10', weight: CIRCLE_DECAY.realReturnWeight, revival: true });
    expect(run.outcomes).toMatchObject([{ status: 'archived', why: 'ended' }]);
    expect(notes.getOccasion('lan-2026')?.status).toBe('archived');
    // Idempotent: the next night counts nothing twice and brings nothing back again.
    expect((await runLifecycle(deps(createCapturingClient([]).client), NOW)).revived).toEqual([]);
  });

  it('lists the circles fading, and runs after the dreams on a night', async () => {
    notes.writeCircles([circle('tarkov')], { updatedBy: 'dream' });
    notes.recordActivity(notes.getCircle('tarkov')?.id ?? 0, { '2026-06': 4, '2026-07': 4 }, { mode: 'add' });
    // The group's weekly refresh answers "nothing to change".
    const { client } = createCapturingClient([reply({ notes: [], change_summary: '' })]);
    const night = await runNightlyDream(deps(client));
    expect(night.fading).toEqual(['tarkov']);
    expect(night.lifecycle).toBeUndefined();
  });
});

describe('owner edits of occasions and archives', () => {
  it('drafts an edit of one occasion, previews its dates and saves it', async () => {
    notes.writeOccasions([trip()], { updatedBy: 'dream' });
    const { client, requests } = createCapturingClient([
      reply({
        occasions: [trip({ starts_on: '2027-03-01', ends_on: '2027-03-08', content: '## Plan\nMoved to March.' })],
        change_summary: 'moved to March',
      }),
    ]);
    const proposal = await proposeEdit(
      { target: { scope: 'occasion', slug: 'ski-trip-2027' }, instruction: 'it moved to March 1–8', requestedBy: REMI },
      deps(client),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(requests[0].headers.get('X-Frigidaire-Feature')).toBe('memory_edit');
    expect(messagesOf(requests[0])[1].content).toContain('THE OCCASION:\n<occasion slug="ski-trip-2027"');
    const [change] = previewChanges(notes, proposal.target, proposal.output);
    expect(change).toMatchObject({
      kind: 'occasion',
      change: 'changed',
      detailsBefore: { startsOn: '2027-01-10', endsOn: '2027-01-17' },
      detailsAfter: { startsOn: '2027-03-01', endsOn: '2027-03-08', status: 'planned' },
    });
    expect(applyEdit(proposal, 'it moved to March 1–8', notes).ok).toBe(true);
    expect(notes.getOccasion('ski-trip-2027')).toMatchObject({ startsOn: '2027-03-01', updatedBy: 'edit' });
  });

  it('previews archiving a circle as it is: its status and its memberships ended', () => {
    notes.writeCircles([circle('yugioh')], { updatedBy: 'dream' });
    const output = validateNotesOutput({ archived_circles: ['yugioh'], change_summary: 'over' }, { scope: 'circle' });
    if (!output.ok) throw new Error(output.errors.join('; '));
    const [change] = previewChanges(notes, { scope: 'circle', slug: 'yugioh' }, output.value);
    expect(change).toMatchObject({
      kind: 'circle',
      change: 'changed',
      detailsBefore: { status: null },
      detailsAfter: { status: 'archived' },
    });
    expect(change.membersAfter?.map((m) => m.until)).toEqual(['2026-10', '2026-10']);
    expect(notes.applyNotesOutput({ scope: 'circle', slug: 'yugioh' }, output.value, { updatedBy: 'edit' }).ok).toBe(true);
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
  });
});
