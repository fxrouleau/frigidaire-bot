import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../memoryStore';
import { CIRCLE_DECAY } from './lifecycle';
import { NotesStore, toSqliteUtc } from './notesStore';
import { NOTE_LIMITS } from './schema';

// Fictional cast, placeholder snowflakes.
const REMI = '100000000000000001';
const DALE = '100000000000000002';
const NOVA = '100000000000000003';
const JASPER = '100000000000000004';

let memory: MemoryStore;
let notes: NotesStore;
let clock: Date;

beforeEach(() => {
  clock = new Date('2026-10-06T16:00:00Z');
  memory = new MemoryStore(':memory:');
  notes = new NotesStore(memory, { now: () => clock });
  for (const [id, name] of [
    [REMI, 'Remi'],
    [DALE, 'Dale'],
    [NOVA, 'Nova'],
    [JASPER, 'Jasper'],
  ]) {
    memory.upsertIdentity(id, name);
  }
});

afterEach(() => {
  memory.close();
  vi.unstubAllEnvs();
});

function ftsIntegrity(): void {
  const db = memory.sharedDatabase();
  db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
  const active = (db.prepare('SELECT COUNT(*) AS n FROM notes WHERE active = 1').get() as { n: number }).n;
  const indexed = (db.prepare('SELECT COUNT(*) AS n FROM notes_fts').get() as { n: number }).n;
  expect(indexed).toBe(active);
}

const trip = (over: Record<string, unknown> = {}) => ({
  slug: 'ski-trip-2027',
  title: 'Ski trip',
  content: '## Plan\nA week at Tremblant; chalet booked.',
  aliases: ['the ski trip'],
  starts_on: '2027-01-10',
  ends_on: '2027-01-17',
  place: 'Tremblant',
  participants: [{ id: REMI, role: 'organizer' }, { id: DALE }],
  ...over,
});

const yugioh = (over: Record<string, unknown> = {}) => ({
  slug: 'yugioh',
  title: 'The Yu-Gi-Oh crew',
  content: '## Now\nFriday duels at the card shop.',
  members: [
    { id: REMI, since: '2018' },
    { id: DALE, since: '2018' },
  ],
  ...over,
});

describe('occasions', () => {
  it('creates an occasion with its dates, place, participants and a status, and versions it', () => {
    const result = notes.writeOccasions([trip()], { updatedBy: 'dream', reason: 'trip planned' });
    expect(result.ok).toBe(true);
    const occasion = notes.getOccasion('ski-trip-2027');
    expect(occasion).toMatchObject({
      scope: 'occasion',
      ownerId: null,
      topic: 'ski-trip-2027',
      startsOn: '2027-01-10',
      endsOn: '2027-01-17',
      place: 'Tremblant',
      status: 'planned',
      circle: null,
      version: 1,
    });
    expect(occasion?.members.map((m) => [m.memberId, m.role])).toEqual([
      [REMI, 'organizer'],
      [DALE, null],
    ]);
    expect(notes.getVersions(occasion?.id ?? 0)[0].details).toEqual({
      status: 'planned',
      startsOn: '2027-01-10',
      endsOn: '2027-01-17',
      place: 'Tremblant',
      circle: null,
    });
    expect(notes.occasionsOf(DALE).map((o) => o.occasion.topic)).toEqual(['ski-trip-2027']);
    expect(notes.searchNotes('chalet')[0]?.note.topic).toBe('ski-trip-2027');
    ftsIntegrity();
  });

  it('keeps the stored status when a writer gives none, and gives a new past one "past"', () => {
    notes.writeOccasions([trip({ status: 'cancelled' })], { updatedBy: 'dream' });
    notes.writeOccasions([trip({ content: '## Plan\nCalled off: the hotel fell through.' })], { updatedBy: 'dream' });
    expect(notes.getOccasion('ski-trip-2027')?.status).toBe('cancelled');
    notes.writeOccasions([trip({ slug: 'orchard-trip', starts_on: '2026-09-20', ends_on: null })], {
      updatedBy: 'dream',
    });
    expect(notes.getOccasion('orchard-trip')?.status).toBe('past');
  });

  it('writes nothing for an identical draft, and refuses unknown participants and circles', () => {
    notes.writeOccasions([trip()], { updatedBy: 'dream' });
    expect(notes.writeOccasions([trip()], { updatedBy: 'dream' })).toEqual({
      ok: true,
      written: [],
      removed: [],
      unchanged: ['occasion:ski-trip-2027'],
    });
    const stranger = notes.writeOccasions([trip({ participants: [{ id: REMI }, { id: '100000000000000099' }] })], {
      updatedBy: 'dream',
    });
    expect(stranger.ok ? [] : stranger.errors).toEqual([
      'occasion "ski-trip-2027": participant 100000000000000099 is nobody the bot knows',
    ]);
    const unknownCircle = notes.writeOccasions([trip({ circle: 'winter-dinners' })], { updatedBy: 'dream' });
    expect(unknownCircle.ok ? [] : unknownCircle.errors[0]).toContain('"circle" winter-dinners is not a circle');
    notes.writeCircles([yugioh({ slug: 'winter-dinners', title: 'Winter dinners' })], { updatedBy: 'dream' });
    expect(notes.writeOccasions([trip({ circle: 'winter-dinners' })], { updatedBy: 'dream' }).ok).toBe(true);
    expect(notes.getOccasion('ski-trip-2027')?.circle).toBe('winter-dinners');
  });

  it("lets a person's write touch only the occasions they take part in", () => {
    notes.writeNotes({ scope: 'person', ownerId: NOVA }, [{ topic: 'profile', title: 'Nova', content: 'x' }], {
      updatedBy: 'dream',
    });
    const outside = notes.writeNotes({ scope: 'person', ownerId: NOVA }, [], {
      updatedBy: 'dream',
      occasions: [trip()],
    });
    expect(outside.ok ? [] : outside.errors).toEqual([
      'occasion "ski-trip-2027": a person\'s notes only change occasions they take part in',
    ]);
    const joining = notes.writeNotes({ scope: 'person', ownerId: NOVA }, [], {
      updatedBy: 'dream',
      occasions: [trip({ participants: [{ id: REMI }, { id: DALE }, { id: NOVA, role: 'maybe' }] })],
    });
    expect(joining.ok).toBe(true);
  });

  it('removes an occasion as a version and caps the occasions that are not archived', () => {
    notes.writeOccasions([trip()], { updatedBy: 'dream' });
    const removed = notes.writeOccasions([], { updatedBy: 'edit', removeOccasions: ['ski-trip-2027'] });
    expect(removed.ok && removed.removed.map((n) => [n.topic, n.active])).toEqual([['ski-trip-2027', false]]);
    expect(notes.getOccasion('ski-trip-2027')).toBeUndefined();

    const many = Array.from({ length: NOTE_LIMITS.maxOccasions }, (_, i) => trip({ slug: `trip-${i}` }));
    expect(notes.writeOccasions(many, { updatedBy: 'dream' }).ok).toBe(true);
    const over = notes.writeOccasions([trip({ slug: 'one-more' })], { updatedBy: 'dream' });
    expect(over.ok ? [] : over.errors).toEqual([
      `${NOTE_LIMITS.maxOccasions + 1} occasions that aren't archived, over the limit of ${NOTE_LIMITS.maxOccasions}`,
    ]);
    // An archived one no longer counts.
    const first = notes.getOccasion('trip-0');
    expect(notes.archiveNote(first?.id ?? 0, { updatedBy: 'dream', content: 'A trace.' }).ok).toBe(true);
    expect(notes.writeOccasions([trip({ slug: 'one-more' })], { updatedBy: 'dream' }).ok).toBe(true);
  });

  it('undoes an occasion change, dates and status included', () => {
    notes.writeOccasions([trip()], { updatedBy: 'dream' });
    notes.writeOccasions([trip({ starts_on: '2027-03-01', ends_on: '2027-03-08', status: 'planned' })], {
      updatedBy: 'dream',
    });
    const id = notes.getOccasion('ski-trip-2027')?.id ?? 0;
    expect(notes.undo(id).ok).toBe(true);
    expect(notes.getOccasion('ski-trip-2027')).toMatchObject({ startsOn: '2027-01-10', endsOn: '2027-01-17', version: 3 });
  });

  it('lists occasions, archived ones only on request', () => {
    notes.writeOccasions([trip(), trip({ slug: 'orchard-trip', starts_on: '2026-10-17', ends_on: null })], {
      updatedBy: 'dream',
    });
    notes.archiveNote(notes.getOccasion('orchard-trip')?.id ?? 0, { updatedBy: 'dream', content: 'A trace.' });
    expect(notes.listOccasions().map((o) => o.topic)).toEqual(['ski-trip-2027']);
    expect(notes.listOccasions({ includeArchived: true }).map((o) => o.topic)).toEqual(['orchard-trip', 'ski-trip-2027']);
    // Still readable and searchable.
    expect(notes.getOccasion('orchard-trip')?.status).toBe('archived');
    expect(notes.searchNotes('trace')[0]?.note.topic).toBe('orchard-trip');
  });
});

describe('the journal around an occasion', () => {
  it('reads its participants’ rows around its dates, and rows that name it from further around', async () => {
    notes.writeOccasions([trip({ starts_on: '2026-09-10', ends_on: '2026-09-12', status: 'planned' })], {
      updatedBy: 'dream',
    });
    const save = (content: string, day: string) =>
      memory.save({
        category: 'event',
        subject: 'Remi',
        subject_user_id: REMI,
        content,
        source: 'observation',
        observed_at: new Date(`${day}T18:00:00Z`),
      });
    await save('Got windburnt on day one on the slopes.', '2026-09-11');
    await save('Booked the chalet for the trip.', '2026-09-08');
    await save('Ski trip: still talking about the cliff jump.', '2026-10-01');
    await save('Started a new job.', '2026-10-01');
    await save('Unrelated thing from the summer.', '2026-07-01');
    await memory.save({ category: 'fact', subject: 'Nova', subject_user_id: NOVA, content: 'Nova on the slopes too.' });
    const rows = notes.occasionJournal(notes.getOccasion('ski-trip-2027') ?? (undefined as never));
    expect(rows.map((r) => r.content)).toEqual([
      'Got windburnt on day one on the slopes.',
      'Booked the chalet for the trip.',
      'Ski trip: still talking about the cliff jump.',
    ]);
  });
});

describe('archiving circles', () => {
  it('archives a circle as it is: its current memberships end, it leaves listings and limits, stays searchable', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const result = notes.writeCircles([], { updatedBy: 'dream', archiveCircles: ['yugioh'] });
    expect(result.ok && result.written.map((n) => [n.topic, n.status])).toEqual([['yugioh', 'archived']]);
    const archived = notes.getCircle('yugioh');
    expect(archived?.members.map((m) => [m.memberId, m.until])).toEqual([
      [REMI, '2026-10'],
      [DALE, '2026-10'],
    ]);
    expect(notes.listCircles()).toEqual([]);
    expect(notes.listCircles({ includeArchived: true }).map((c) => c.topic)).toEqual(['yugioh']);
    expect(notes.circlesOf(REMI, { includeFormer: true })).toEqual([]);
    expect(notes.circlesOf(REMI, { includeFormer: true, includeArchived: true }).map((c) => c.circle.topic)).toEqual([
      'yugioh',
    ]);
    expect(notes.searchNotes('duels')[0]?.note.topic).toBe('yugioh');
    // Archiving it again changes nothing.
    expect(notes.writeCircles([], { updatedBy: 'dream', archiveCircles: ['yugioh'] })).toMatchObject({
      unchanged: ['circle:yugioh'],
    });
    ftsIntegrity();
  });

  it('frees the circle limits: an archived circle counts toward neither the total nor anyone’s circles', () => {
    const pair = (i: number) =>
      yugioh({ slug: `circle-${i}`, title: `Circle ${i}`, members: [{ id: REMI }, { id: DALE }] });
    for (let i = 0; i < NOTE_LIMITS.maxCirclesPerMember; i++) {
      expect(notes.writeCircles([pair(i)], { updatedBy: 'dream' }).ok).toBe(true);
    }
    expect(notes.writeCircles([pair(99)], { updatedBy: 'dream' }).ok).toBe(false);
    notes.writeCircles([], { updatedBy: 'dream', archiveCircles: ['circle-0'] });
    expect(notes.writeCircles([pair(99)], { updatedBy: 'dream' }).ok).toBe(true);
  });

  it('revives an archived circle written again, as a real return; written and archived, it stays archived', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    notes.writeCircles([], { updatedBy: 'dream', archiveCircles: ['yugioh'] });
    const trace = yugioh({ content: '## History\nFriday duels 2018–2020.', members: [{ id: REMI }, { id: DALE }] });
    expect(notes.writeCircles([trace], { updatedBy: 'edit', archiveCircles: ['yugioh'] }).ok).toBe(true);
    expect(notes.getCircle('yugioh')).toMatchObject({ status: 'archived', content: '## History\nFriday duels 2018–2020.' });
    expect(notes.activityOf(notes.getCircle('yugioh')?.id ?? 0)).toEqual([]);

    expect(notes.writeCircles([yugioh({ content: '## Now\nBack to Friday duels.' })], { updatedBy: 'dream' }).ok).toBe(
      true,
    );
    const back = notes.getCircle('yugioh');
    expect(back?.status).toBeNull();
    expect(notes.listCircles().map((c) => c.topic)).toEqual(['yugioh']);
    expect(notes.activityOf(back?.id ?? 0)).toEqual([
      { month: '2026-10', weight: CIRCLE_DECAY.realReturnWeight, revival: true },
    ]);
  });

  it('archives with a trace (archiveNote), refusing a note that changed since and keeping occasion participants', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const circle = notes.getCircle('yugioh');
    const stale = notes.archiveNote(circle?.id ?? 0, { updatedBy: 'dream', content: 'x', expectVersion: 7 });
    expect(stale.ok ? [] : stale.errors).toEqual(['circle "yugioh" changed meanwhile (v1, not v7)']);
    const bad = notes.archiveNote(circle?.id ?? 0, { updatedBy: 'dream', content: 'duel at <@100000000000000099>' });
    expect(bad.ok).toBe(false);
    const done = notes.archiveNote(circle?.id ?? 0, {
      updatedBy: 'dream',
      content: '## History\nFriday duels 2018–2020.',
      reason: 'archived as a trace',
      expectVersion: 1,
    });
    expect(done.ok && done.written[0]).toMatchObject({ status: 'archived', content: '## History\nFriday duels 2018–2020.' });
    expect(notes.getVersions(circle?.id ?? 0)[0]).toMatchObject({ reason: 'archived as a trace', updatedBy: 'dream' });

    notes.writeOccasions([trip({ participants: [{ id: REMI }, { id: DALE, until: '2026-12', role: 'bailed' }] })], {
      updatedBy: 'dream',
    });
    const occasion = notes.getOccasion('ski-trip-2027');
    notes.archiveNote(occasion?.id ?? 0, { updatedBy: 'dream', content: 'A trace.' });
    expect(notes.getOccasion('ski-trip-2027')?.members.map((m) => m.until)).toEqual([null, '2026-12']);
    expect(notes.archiveNote(9_999, { updatedBy: 'dream' }).ok).toBe(false);
  });

  it('undoes an archive: the full text, the memberships and a live status come back, for real', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    notes.archiveNote(id, { updatedBy: 'dream', content: 'A trace.' });
    expect(notes.undo(id).ok).toBe(true);
    const back = notes.getCircle('yugioh');
    expect(back).toMatchObject({ status: null, content: '## Now\nFriday duels at the card shop.', version: 3 });
    expect(back?.members.map((m) => m.until)).toEqual([null, null]);
    expect(notes.activityOf(id)).toEqual([{ month: '2026-10', weight: CIRCLE_DECAY.realReturnWeight, revival: true }]);
  });
});

describe('circle activity', () => {
  it('adds journal rows to a month, raises a seed to it, and skips anything malformed', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    expect(notes.recordActivity(id, { '2026-09': 2 }, { mode: 'add' })).toEqual({ ok: true, changed: ['2026-09'] });
    notes.recordActivity(id, { '2026-09': 3, '2026-13': 4, nope: 1, '2026-08': 0 }, { mode: 'add' });
    notes.recordActivity(id, { '2026-09': 4, '2019-03': 12 }, { mode: 'max' });
    expect(notes.recordActivity(id, { '2019-03': 12 }, { mode: 'max' })).toEqual({ ok: true, changed: [] });
    expect(notes.activityOf(id)).toEqual([
      { month: '2019-03', weight: 12 },
      { month: '2026-09', weight: 5 },
    ]);
    expect(notes.circleActivity().get(id)).toEqual(notes.activityOf(id));
    notes.writeOccasions([trip()], { updatedBy: 'dream' });
    expect(notes.recordActivity(notes.getOccasion('ski-trip-2027')?.id ?? 0, { '2026-09': 1 }, { mode: 'add' }).ok).toBe(
      false,
    );
  });

  it('brings an archived circle back on new activity, provisionally, never on old months or a seed', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    notes.archiveNote(id, { updatedBy: 'dream', content: 'A trace.' });
    expect(notes.recordActivity(id, { '2019-03': 40 }, { mode: 'max', revive: false })).toMatchObject({ ok: true });
    expect(notes.recordActivity(id, { '2020-01': 3 }, { mode: 'add', revive: true })).not.toHaveProperty('revived');
    expect(notes.getCircle('yugioh')?.status).toBe('archived');

    clock = new Date('2027-03-15T16:00:00Z');
    const back = notes.recordActivity(id, { '2027-03': 2 }, { mode: 'add', revive: true, reason: 'Remi and Dale dueled' });
    expect(back.ok && back.revived).toMatchObject({ status: null, content: 'A trace.', updatedBy: 'dream' });
    expect(notes.getVersions(id)[0].reason).toBe('came back: Remi and Dale dueled');
    expect(notes.activityOf(id).at(-1)).toEqual({ month: '2027-03', weight: 2, revival: true });
    expect(notes.getCircle('yugioh')?.updatedAt).toBe(toSqliteUtc(clock));
  });

  it('keeps ambient sightings apart from the weight, capped per month, and never revives on them', () => {
    notes.writeCircles([yugioh()], { updatedBy: 'dream' });
    const id = notes.getCircle('yugioh')?.id ?? 0;
    notes.recordActivity(id, {}, { mode: 'add', ambient: { '2026-09': 2 } });
    notes.recordActivity(id, { '2026-09': 3 }, { mode: 'add', ambient: { '2026-09': 5, '2026-10': 1 } });
    expect(notes.activityOf(id)).toEqual([
      { month: '2026-09', weight: 3, ambient: CIRCLE_DECAY.ambientMonthCap },
      { month: '2026-10', weight: 0, ambient: 1 },
    ]);
    notes.archiveNote(id, { updatedBy: 'dream', content: 'A trace.' });
    expect(notes.recordActivity(id, {}, { mode: 'add', revive: true, ambient: { '2026-10': 1 } })).not.toHaveProperty('revived');
    expect(notes.getCircle('yugioh')?.status).toBe('archived');
  });

  it("postpones a revival that would put a member over the per-member limit, and refuses only writes that add to a member's count", () => {
    const partners = Array.from({ length: NOTE_LIMITS.maxCirclesPerMember + 1 }, (_, i) => `1000000000009${String(i).padStart(5, '0')}`);
    partners.forEach((id, i) => memory.upsertIdentity(id, `Partner ${i}`));
    const pair = (slug: string, partner: string) => ({
      slug,
      title: `The ${slug} crew`,
      content: `## Now\n${slug} nights.`,
      members: [{ id: REMI, since: '2020' }, { id: partner, since: '2020' }],
    });
    // An old circle of Remi's, archived before the others filled the limit.
    const extra = partners[NOTE_LIMITS.maxCirclesPerMember];
    expect(notes.writeCircles([pair('old-thing', extra)], { updatedBy: 'dream' }).ok).toBe(true);
    const old = notes.getCircle('old-thing')?.id ?? 0;
    notes.archiveNote(old, { updatedBy: 'dream', content: 'A trace.' });
    const full = partners.slice(0, NOTE_LIMITS.maxCirclesPerMember).map((p, i) => pair(`thing-${i}`, p));
    expect(notes.writeCircles(full.slice(0, 10), { updatedBy: 'dream' })).toMatchObject({ ok: true });
    expect(notes.writeCircles(full.slice(10), { updatedBy: 'dream' }).ok).toBe(true);
    expect(notes.writeCircles([pair('one-more', DALE)], { updatedBy: 'dream' }).ok).toBe(false);
    const back = notes.recordActivity(old, { '2026-10': 12 }, { mode: 'add', revive: true, members: [REMI, extra] });
    expect(back).toMatchObject({ ok: true, changed: ['2026-10'] });
    expect(back.ok && back.postponed?.[0]).toContain(`member ${REMI} would be current in 17 present circles, over the limit of 16`);
    expect(notes.getCircle('old-thing')?.status).toBe('archived');

    // A store already past the limit (here by hand) keeps saving writes that don't add to it.
    memory.sharedDatabase().prepare("UPDATE notes SET status = NULL WHERE id = ?").run(old);
    memory.sharedDatabase().prepare('UPDATE note_members SET until = NULL WHERE note_id = ? AND member_id = ?').run(old, REMI);
    expect(notes.writeCircles([{ ...full[0], content: '## Now\nStill going.' }], { updatedBy: 'dream' }).ok).toBe(true);
    expect(notes.writeCircles([pair('newest', DALE)], { updatedBy: 'dream' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining(`member ${REMI} would be current in 18 present circles`)],
    });
  });
});

describe('the occasions upgrade of an existing memory.db', () => {
  it('rebuilds the notes table in place: every note, member, version and id kept, occasions writable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-upgrade-'));
    const file = path.join(dir, 'memory.db');
    try {
      const old = new MemoryStore(file);
      // The notes tables as they shipped before occasions.
      old.sharedDatabase().exec(`
        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL CHECK (scope IN ('person', 'group', 'circle')),
          owner_id TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          aliases TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          UNIQUE (scope, owner_id, topic), CHECK ((scope = 'person') = (owner_id != ''))
        );
        CREATE TABLE note_members (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, member_id TEXT NOT NULL,
          since TEXT, until TEXT, role TEXT, PRIMARY KEY (note_id, member_id)
        ) WITHOUT ROWID;
        CREATE TABLE note_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
          members TEXT, active INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, reason TEXT,
          linked TEXT, UNIQUE (note_id, version)
        );
        INSERT INTO notes (id, scope, owner_id, topic, title, content, updated_by)
          VALUES (5, 'person', '${REMI}', 'profile', 'Remi', 'Runs the bakery.', 'import'),
                 (9, 'circle', '', 'mtg', 'The MTG crew', 'Friday drafts.', 'import');
        INSERT INTO note_members (note_id, member_id, since) VALUES (9, '${REMI}', '2021'), (9, '${DALE}', '2021');
        INSERT INTO note_versions (note_id, version, title, content, members, active, updated_at, updated_by)
          VALUES (5, 1, 'Remi', 'Runs the bakery.', NULL, 1, '2026-09-27 12:00:00', 'import'),
                 (9, 1, 'The MTG crew', 'Friday drafts.', '[]', 1, '2026-09-27 12:00:00', 'import');
      `);
      old.upsertIdentity(REMI, 'Remi');
      old.upsertIdentity(DALE, 'Dale');
      old.close();

      const reopened = new MemoryStore(file);
      const upgraded = new NotesStore(reopened, { now: () => clock });
      const db = reopened.sharedDatabase();
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notes'").get() as { sql: string }).sql).toContain(
        "'occasion'",
      );
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(upgraded.getNoteById(5)).toMatchObject({ topic: 'profile', content: 'Runs the bakery.', status: null });
      expect(upgraded.getCircle('mtg')).toMatchObject({ id: 9, status: null });
      expect(upgraded.getCircle('mtg')?.members.map((m) => m.memberId)).toEqual([REMI, DALE]);
      expect(upgraded.getVersions(9)).toHaveLength(1);
      // The FTS triggers are back: new writes are indexed, old rows still found.
      expect(upgraded.searchNotes('bakery')[0]?.note.id).toBe(5);
      expect(upgraded.writeOccasions([trip()], { updatedBy: 'dream' }).ok).toBe(true);
      expect(upgraded.getOccasion('ski-trip-2027')?.id).toBeGreaterThan(9);
      expect(upgraded.searchNotes('chalet')[0]?.note.topic).toBe('ski-trip-2027');
      // Undo of a version from before the upgrade still works.
      expect(upgraded.writeCircles([yugioh({ slug: 'mtg', title: 'The MTG crew' })], { updatedBy: 'dream' }).ok).toBe(
        true,
      );
      expect(upgraded.undo(9).ok).toBe(true);
      expect(upgraded.getCircle('mtg')).toMatchObject({ content: 'Friday drafts.', status: null });
      reopened.close();

      // Opening it again changes nothing.
      const again = new MemoryStore(file);
      expect(new NotesStore(again).getOccasion('ski-trip-2027')?.place).toBe('Tremblant');
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to upgrade inside a transaction rather than cascade-delete the notes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-upgrade-'));
    const file = path.join(dir, 'memory.db');
    try {
      const old = new MemoryStore(file);
      old.sharedDatabase().exec(`
        CREATE TABLE notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL CHECK (scope IN ('person', 'group', 'circle')),
          owner_id TEXT NOT NULL DEFAULT '', topic TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          aliases TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          UNIQUE (scope, owner_id, topic), CHECK ((scope = 'person') = (owner_id != ''))
        );
      `);
      expect(() => old.sharedDatabase().transaction(() => new NotesStore(old))()).toThrow(
        'cannot run inside a transaction',
      );
      old.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
